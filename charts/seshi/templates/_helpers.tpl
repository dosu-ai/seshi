{{/* Names and labels. */}}
{{- define "seshi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "seshi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Labels on everything the release makes, without a component. */}}
{{- define "seshi.releaseLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "seshi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "seshi.labels" -}}
{{ include "seshi.releaseLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{- define "seshi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "seshi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end }}

{{- define "seshi.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "seshi.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The image reference: a digest wins over the tag, and the tag defaults to appVersion. */}}
{{- define "seshi.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{/* The Secret holding the bucket's keys, or "" when there is none. */}}
{{- define "seshi.storeSecretName" -}}
{{- $c := .Values.store.credentials }}
{{- if $c.existingSecret }}
{{- $c.existingSecret }}
{{- else if $c.accessKeyId }}
{{- printf "%s-store" (include "seshi.fullname" .) }}
{{- end }}
{{- end }}

{{- define "seshi.dataClaimName" -}}
{{- default (printf "%s-data" (include "seshi.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{/* Refuse values that would render something seshi refuses, or that loses data. */}}
{{- define "seshi.validate" -}}
{{- $url := required "store.url is required: s3://bucket/prefix, r2://bucket/prefix or file:///data/store (docs/kubernetes.md)" .Values.store.url }}
{{- $config := .Values.config | default dict }}
{{- if hasKey $config "store" }}
{{- fail "config.store: set the store with the chart's store.* values" }}
{{- end }}
{{- $server := get $config "server" | default dict }}
{{- if hasKey $server "listen" }}
{{- fail "config.server.listen: the chart listens on :7200; set service.port to change the Service's port" }}
{{- end }}
{{- if hasKey $server "roles" }}
{{- fail "config.server.roles: this chart runs one instance with both roles" }}
{{- end }}
{{- if and (hasPrefix "file:" $url) (not .Values.persistence.enabled) }}
{{- fail "store.url is a file:// store but persistence.enabled is false: the sessions would be lost with the pod" }}
{{- end }}
{{- range $name, $_ := .Values.dropIns }}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]*$" $name) }}
{{- fail (printf "dropIns.%s: a drop-in name is lower-case letters, digits and dashes" $name) }}
{{- end }}
{{- end }}
{{- range $file, $_ := .Values.redactionPacks }}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._-]*$" $file) }}
{{- fail (printf "redactionPacks.%s: a pack's file name is letters, digits, dots, dashes and underscores" $file) }}
{{- end }}
{{- end }}
{{- end }}

{{/* seshi.toml: the user's config, with the store, the listen address, the index path and the
chart's packs set by the chart. */}}
{{- define "seshi.toml" -}}
{{- $config := deepCopy (.Values.config | default dict) }}
{{- $s := .Values.store }}
{{- $store := dict "url" $s.url }}
{{- range $key, $value := dict "region" $s.region "endpoint" $s.endpoint "account_id" $s.accountId "deployment_id" $s.deploymentId "org" $s.org }}
{{- if $value }}
{{- $_ := set $store $key $value }}
{{- end }}
{{- end }}
{{- $_ := set $config "store" $store }}
{{- $server := get $config "server" | default dict }}
{{- $_ := set $server "listen" ":7200" }}
{{- $_ := set $config "server" $server }}
{{- $search := get $config "search" | default dict }}
{{- if not (hasKey $search "path") }}
{{- $_ := set $search "path" "/data/search/index.sqlite" }}
{{- end }}
{{- $_ := set $config "search" $search }}
{{- if .Values.redactionPacks }}
{{- $redaction := get $config "redaction" | default dict }}
{{- $packs := get $redaction "packs" | default list }}
{{- range $file := keys .Values.redactionPacks | sortAlpha }}
{{- $packs = append $packs (printf "/etc/seshi/packs/%s" $file) }}
{{- end }}
{{- $_ := set $redaction "packs" $packs }}
{{- $_ := set $config "redaction" $redaction }}
{{- end }}
{{- toToml $config }}
{{- end }}
