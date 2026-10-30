#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUN_MEDIA_ALERT_DELIVERY_TEST:-}" != "1" ]]; then
  printf '%s\n' 'Opt-in only. Set RUN_MEDIA_ALERT_DELIVERY_TEST=1 to run the local Docker integration proof.' >&2
  exit 2
fi

for tool in docker curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required local tool is missing: %s\n' "$tool" >&2
    exit 2
  fi
done

docker info >/dev/null

PROMETHEUS_IMAGE='prom/prometheus@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2'
ALERTMANAGER_IMAGE='prom/alertmanager@sha256:286ad8838533a5a01d89bd09643f43d2b68b65203123b5700e54a8f80ff9c1f4'
for image in "$PROMETHEUS_IMAGE" "$ALERTMANAGER_IMAGE"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf 'Pinned image is not cached: %s\n' "$image" >&2
    printf 'Fetch it explicitly with: docker pull %s\n' "$image" >&2
    exit 2
  fi
done

repo_root="$(git rev-parse --show-toplevel)"
fixture="$repo_root/infra/monitoring/tests/alert-delivery.fixture.yml"
test_id="media-alert-delivery-$$"
network="$test_id"
alertmanager_container="$test_id-alertmanager"
prometheus_container="$test_id-prometheus"
temp_dir="$(mktemp -d)"
state_file="$temp_dir/provider-state"
port_file="$temp_dir/exporter-port"
exporter_log="$temp_dir/exporter.log"
exporter_gradle_pid=''
exporter_url=''

cleanup() {
  printf 'stop' > "$state_file" 2>/dev/null || true
  if [[ -n "$exporter_url" ]]; then
    curl --silent --max-time 1 "$exporter_url/metrics" >/dev/null 2>&1 || true
  fi
  if [[ -n "$exporter_gradle_pid" ]]; then
    kill "$exporter_gradle_pid" >/dev/null 2>&1 || true
    wait "$exporter_gradle_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$prometheus_container" "$alertmanager_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT

printf 'healthy' > "$state_file"
"$repo_root/gradlew" --no-daemon \
  :services:media:audio-video-observability:runAlertDeliveryExporterFixture \
  --args="$state_file $port_file" >"$exporter_log" 2>&1 &
exporter_gradle_pid=$!

deadline=$((SECONDS + 120))
while [[ ! -s "$port_file" ]] && (( SECONDS < deadline )); do
  if ! kill -0 "$exporter_gradle_pid" >/dev/null 2>&1; then
    printf '%s\n' 'Media exporter fixture exited before publishing its port.' >&2
    cat "$exporter_log" >&2
    exit 1
  fi
  sleep 1
done
if [[ ! -s "$port_file" ]]; then
  printf '%s\n' 'Media exporter fixture did not publish its port within 120 seconds.' >&2
  cat "$exporter_log" >&2
  exit 1
fi
exporter_port="$(cat "$port_file")"
if [[ ! "$exporter_port" =~ ^[0-9]+$ ]]; then
  printf 'Invalid Media exporter fixture port: %s\n' "$exporter_port" >&2
  exit 1
fi
exporter_url="http://127.0.0.1:$exporter_port"

cat > "$temp_dir/alertmanager.yml" <<YAML
route:
  receiver: media-local-test
  group_wait: 1s
  group_interval: 1s
  repeat_interval: 1h
receivers:
  - name: media-local-test
    webhook_configs:
      - url: http://host.docker.internal:$exporter_port/alert-webhook
        send_resolved: true
YAML

cat > "$temp_dir/prometheus.yml" <<YAML
global:
  scrape_interval: 1s
  evaluation_interval: 1s
rule_files:
  - /etc/prometheus/alert-delivery.fixture.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: [alertmanager:9093]
scrape_configs:
  - job_name: media-exporter-fixture
    metrics_path: /metrics
    static_configs:
      - targets: [host.docker.internal:$exporter_port]
YAML

docker network create "$network" >/dev/null
docker run --detach --rm \
  --name "$alertmanager_container" \
  --network "$network" --network-alias alertmanager \
  --add-host=host.docker.internal:host-gateway \
  --publish 127.0.0.1::9093 \
  --volume "$temp_dir/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$ALERTMANAGER_IMAGE" \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --web.listen-address=0.0.0.0:9093 >/dev/null

alertmanager_port="$(docker port "$alertmanager_container" 9093/tcp | sed 's/.*://')"
if [[ ! "$alertmanager_port" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the local Alertmanager API port: %s\n' "$alertmanager_port" >&2
  exit 1
fi
alertmanager_url="http://127.0.0.1:$alertmanager_port"

docker run --detach --rm \
  --name "$prometheus_container" \
  --network "$network" --network-alias prometheus \
  --add-host=host.docker.internal:host-gateway \
  --publish 127.0.0.1::9090 \
  --volume "$temp_dir/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  --volume "$fixture:/etc/prometheus/alert-delivery.fixture.yml:ro" \
  "$PROMETHEUS_IMAGE" \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=1h >/dev/null

prometheus_port="$(docker port "$prometheus_container" 9090/tcp | sed 's/.*://')"
if [[ ! "$prometheus_port" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the local Prometheus API port: %s\n' "$prometheus_port" >&2
  exit 1
fi
prometheus_url="http://127.0.0.1:$prometheus_port"

deadline=$((SECONDS + 90))
wait_for_query() {
  local query="$1"
  local jq_expression="$2"
  local response=''
  while (( SECONDS < deadline )); do
    if response="$(curl --fail --silent --show-error --max-time 2 --get \
        --data-urlencode "query=$query" "$prometheus_url/api/v1/query" 2>/dev/null)" \
        && jq -e "$jq_expression" <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  printf 'Prometheus query did not reach its expected state: %s\nResponse: %s\n' \
    "$query" "${response:-<unavailable>}" >&2
  docker logs "$prometheus_container" >&2 || true
  return 1
}

wait_for_api() {
  local url="$1"
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  printf 'Local service did not become ready: %s\n' "$url" >&2
  return 1
}

wait_for_api "$alertmanager_url/-/ready"
wait_for_query 'up{job="media-exporter-fixture"}' \
  '.status == "success" and any(.data.result[]; .metric.job == "media-exporter-fixture" and .value[1] == "1")'
wait_for_query 'media_provider_profile_readiness{service="stt",modality="stt",provider_id="alert-delivery-fixture",contract_version="v1"}' \
  '.status == "success" and any(.data.result[]; .value[1] == "1")'

source_scrape="$(curl --fail --silent --show-error --max-time 2 \
  -H 'Accept: text/plain; version=0.0.4' "$exporter_url/metrics")"
if ! grep -Fq 'media_provider_quality_observation_timestamp_seconds{' <<<"$source_scrape" \
    || ! grep -Eq 'media_provider_quality_observation_timestamp_seconds\{[^}]*\} NaN$' <<<"$source_scrape"; then
  printf '%s\n' 'Media exporter did not retain unknown quality freshness as NaN.' >&2
  exit 1
fi

sleep 3
initial_alerts="$(curl --fail --silent --show-error --max-time 2 "$alertmanager_url/api/v2/alerts")"
if jq -e 'any(.[]; .labels.alertname == "MediaProviderProfileUnavailableFixture" and .status.state == "active")' \
    <<<"$initial_alerts" >/dev/null; then
  printf '%s\n' 'Alert was active while the Media exporter reported healthy readiness.' >&2
  exit 1
fi

printf 'unavailable' > "$state_file"
wait_for_query 'media_provider_profile_readiness{service="stt",modality="stt",provider_id="alert-delivery-fixture",contract_version="v1"}' \
  '.status == "success" and any(.data.result[]; .value[1] == "-1")'

delivered=0
while (( SECONDS < deadline )); do
  if response="$(curl --fail --silent --show-error --max-time 2 "$alertmanager_url/api/v2/alerts" 2>/dev/null)" \
      && jq -e '
        any(.[];
          .status.state == "active" and
          .labels.alertname == "MediaProviderProfileUnavailableFixture" and
          .labels.severity == "warning" and
          .labels.product == "audio-video" and
          .labels.component == "provider-profile-fixture" and
          .labels.source == "fixture" and
          .labels.service == "stt" and
          .labels.modality == "stt" and
          ((.labels | keys | sort) == ["alertname", "component", "modality", "product", "service", "severity", "source"]) and
          any(.receivers[]; .name == "media-local-test") and
          .annotations.summary == "Fixture Media provider profile unavailable"
        )
      ' <<<"$response" >/dev/null; then
    delivered=1
    break
  fi
  sleep 1
done
if [[ "$delivered" != 1 ]]; then
  printf '%s\n' 'Media profile alert did not reach the configured local Alertmanager receiver.' >&2
  printf 'Alertmanager response: %s\n' "${response:-<unavailable>}" >&2
  docker logs "$prometheus_container" >&2 || true
  docker logs "$alertmanager_container" >&2 || true
  exit 1
fi

# A receiver route alone does not establish webhook delivery. Verify Alertmanager
# POSTed the firing notification to the bounded test-only sink.
webhook_fire_seen=0
webhook_deadline=$((SECONDS + 30))
while (( SECONDS < webhook_deadline )); do
  if webhook_receipts="$(curl --fail --silent --show-error --max-time 2 \
      "$exporter_url/alert-receipts" 2>/dev/null)" \
      && jq -e '.firing >= 1 and .resolved == 0' <<<"$webhook_receipts" >/dev/null; then
    webhook_fire_seen=1
    break
  fi
  sleep 1
done
if [[ "$webhook_fire_seen" != 1 ]]; then
  printf '%s\n' 'Alertmanager routed the alert, but no firing webhook POST reached the sink.' >&2
  exit 1
fi

printf 'healthy' > "$state_file"
wait_for_query 'media_provider_profile_readiness{service="stt",modality="stt",provider_id="alert-delivery-fixture",contract_version="v1"}' \
  '.status == "success" and any(.data.result[]; .value[1] == "1")'

recovered=0
while (( SECONDS < deadline )); do
  if response="$(curl --fail --silent --show-error --max-time 2 "$alertmanager_url/api/v2/alerts" 2>/dev/null)" \
      && ! jq -e 'any(.[]; .labels.alertname == "MediaProviderProfileUnavailableFixture" and .status.state == "active")' \
        <<<"$response" >/dev/null; then
    recovered=1
    break
  fi
  sleep 1
done
if [[ "$recovered" != 1 ]]; then
  printf '%s\n' 'Alertmanager continued to report the Media profile alert active after exporter recovery.' >&2
  printf 'Alertmanager response: %s\n' "${response:-<unavailable>}" >&2
  exit 1
fi

# send_resolved is contractual. Verify a distinct HTTP POST after recovery.
webhook_resolve_seen=0
webhook_deadline=$((SECONDS + 30))
while (( SECONDS < webhook_deadline )); do
  if webhook_receipts="$(curl --fail --silent --show-error --max-time 2 \
      "$exporter_url/alert-receipts" 2>/dev/null)" \
      && jq -e '.firing >= 1 and .resolved >= 1' <<<"$webhook_receipts" >/dev/null; then
    webhook_resolve_seen=1
    break
  fi
  sleep 1
done
if [[ "$webhook_resolve_seen" != 1 ]]; then
  printf '%s\n' 'No resolved webhook HTTP POST reached the test sink.' >&2
  exit 1
fi

printf '%s\n' 'PASS: fixture exporter -> Prometheus -> Alertmanager -> local webhook HTTP POST fired and resolved.'
printf '%s\n' 'This proves actual test-only webhook transport, NOT external pager delivery, real provider quality, or production admission. Quality freshness remained NaN.'
