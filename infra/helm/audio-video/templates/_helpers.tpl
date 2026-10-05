{{/*
Expand chart name
*/}}
{{- define "audio-video.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full release name
*/}}
{{- define "audio-video.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chart label
*/}}
{{- define "audio-video.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "audio-video.labels" -}}
helm.sh/chart: {{ include "audio-video.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ghatana-audio-video
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels for a named component
Usage: {{ include "audio-video.selectorLabels" (dict "Release" .Release "component" "stt") }}
*/}}
{{- define "audio-video.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-%s" .Release.Name .component | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name used by the workloads.
*/}}
{{- define "audio-video.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default "audio-video-sa" .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
