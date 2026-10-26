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

cleanup() {
  docker rm -f "$prometheus_container" "$alertmanager_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT

cat > "$temp_dir/alertmanager.yml" <<'YAML'
route:
  receiver: media-local-test
  group_wait: 1s
  group_interval: 1s
  repeat_interval: 1h
receivers:
  - name: media-local-test
YAML

cat > "$temp_dir/prometheus.yml" <<'YAML'
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
  - job_name: media-alert-delivery-fixture
    static_configs:
      - targets: [prometheus:9090]
YAML

docker network create "$network" >/dev/null
docker run --detach --rm \
  --name "$alertmanager_container" \
  --network "$network" --network-alias alertmanager \
  --publish 127.0.0.1::9093 \
  --volume "$temp_dir/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$ALERTMANAGER_IMAGE" \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --web.listen-address=0.0.0.0:9093 >/dev/null

published_port="$(docker port "$alertmanager_container" 9093/tcp | sed 's/.*://')"
if [[ ! "$published_port" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the local Alertmanager API port: %s\n' "$published_port" >&2
  exit 1
fi
alertmanager_url="http://127.0.0.1:$published_port"

docker run --detach --rm \
  --name "$prometheus_container" \
  --network "$network" --network-alias prometheus \
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

deadline=$((SECONDS + 30))
ready=0
while (( SECONDS < deadline )); do
  if curl --fail --silent --show-error --max-time 1 "$alertmanager_url/-/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  printf '%s\n' 'Local Alertmanager did not become ready within 30 seconds.' >&2
  docker logs "$alertmanager_container" >&2 || true
  exit 1
fi

scrape_ready=0
while (( SECONDS < deadline )); do
  if response="$(curl --fail --silent --show-error --max-time 1 --get \
      --data-urlencode 'query=up{job="media-alert-delivery-fixture"}' \
      "$prometheus_url/api/v1/query" 2>/dev/null)" \
      && jq -e '.status == "success" and any(.data.result[]; .metric.job == "media-alert-delivery-fixture" and .metric.instance == "prometheus:9090" and .value[1] == "1")' \
      <<<"$response" >/dev/null; then
    scrape_ready=1
    break
  fi
  sleep 1
done
if [[ "$scrape_ready" != 1 ]]; then
  printf '%s\n' 'Prometheus did not report its fixture self-scrape as healthy within the 30-second integration deadline.' >&2
  printf 'Prometheus response: %s\n' "${response:-<unavailable>}" >&2
  docker logs "$prometheus_container" >&2 || true
  exit 1
fi

delivered=0
while (( SECONDS < deadline )); do
  if response="$(curl --fail --silent --show-error --max-time 2 "$alertmanager_url/api/v2/alerts" 2>/dev/null)" \
      && jq -e '
        any(.[];
          .status.state == "active" and
          .labels.alertname == "MediaAlertDeliveryFixture" and
          .labels.severity == "warning" and
          .labels.product == "audio-video" and
          .labels.component == "alert-delivery-fixture" and
          .labels.source == "fixture" and
          .labels.job == "media-alert-delivery-fixture" and
          .labels.instance == "prometheus:9090" and
          ((.labels | keys | sort) == ["alertname", "component", "instance", "job", "product", "severity", "source"]) and
          any(.receivers[]; .name == "media-local-test") and
          .annotations.summary == "Fixture-triggered local alert delivery"
        )
      ' <<<"$response" >/dev/null; then
    delivered=1
    break
  fi
  sleep 1
done

if [[ "$delivered" != 1 ]]; then
  printf '%s\n' 'Fixture alert did not reach the configured local Alertmanager receiver within the 30-second integration deadline.' >&2
  printf 'Alertmanager response: %s\n' "${response:-<unavailable>}" >&2
  docker logs "$prometheus_container" >&2 || true
  docker logs "$alertmanager_container" >&2 || true
  exit 1
fi

printf 'PASS: fixture alert reached local Alertmanager receiver media-local-test at %s.\n' "$alertmanager_url"
printf '%s\n' 'The alert came from Prometheus self-scrape up=1; no provider, customer, tenant, request, or production metric was used.'
