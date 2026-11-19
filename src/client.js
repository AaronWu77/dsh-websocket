window.__ModuleLoader__.load({
  id: 'dsh-websocket',
  factory(require) {
    const React = require('react');
    const { Button, SegmentedControl, Switch, Tag, Toast } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const { useState, useEffect, useId, useRef } = React;
    /*__DICTIONARIES__*/
    /*__STYLES__*/
    const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const advanced = ['connectionIdleMs', 'connectionMaxAgeMs', 'maxConnections', 'maxContinuationBytes', 'diagnosticsLimit', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'closeTimeoutMs', 'maxFrameBytes', 'maxBufferedEvents', 'maxRequestImageBytes', 'maxRequestImages', 'imageOffloadCountQuantum', 'requestImagePixelBudget', 'requestImageMaxBytes'];
    const clone = value => JSON.parse(JSON.stringify(value));
    const blankModel = () => ({ id: '', contextWindow: 500000, maxTokens: 128000, input: ['text'], reasoningEfforts: [] });
    const blank = () => ({ displayName: '', baseURL: '', apiKeyEnv: '', transport: 'auto', requestFormat: 'standard', clientMetadata: 'off', reuseConnection: true, continuation: true, fallbackAfterFailures: 5, fallbackCooldownMs: 300000, models: [], discover: false, discovery: { contextWindow: 500000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: ['high', 'xhigh', 'max'], exclude: [], ttlMs: 300000, timeoutMs: 10000 } });
    const failureLabel = {
      conflict: 'conflict', 'route-conflict': 'routeConflict', 'source-changed': 'importSourceChanged',
      'endpoint-mismatch': 'importEndpointMismatch', 'model-conflict': 'importModelConflict',
      'invalid-model-selection': 'importSelectionInvalid', 'incompatible-source': 'ineligible',
      'model-reasoning-conflict': 'importReasoningConflict', 'discovery-disabled': 'discoveryDisabled',
      'discovery-failed': 'discoveryFailed', 'unknown-provider': 'routeMissing',
    };
    const sourceReasonLabel = {
      protocol: 'sourceProtocol', 'endpoint-or-credential': 'sourceEndpoint', 'unsupported-transport': 'sourceTransport',
      'custom-capabilities': 'sourceCapabilities', 'explicit-models-required': 'sourceModels', 'duplicate-model': 'importModelConflict',
      'model-metadata-required': 'sourceCapacity', 'custom-reasoning': 'sourceReasoning', 'no-gpt-models': 'sourceModels',
      'custom-headers': 'sourceHeaders', 'invalid-configuration': 'sourceInvalid',
    };
    const bytes = n => n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KiB' : (n / (1024 * 1024)).toFixed(2) + ' MiB';
    function WebSocketIcon({ size = 18, active = false }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
        style: { display: 'block', flexShrink: 0, pointerEvents: 'none' },
      },
      h('circle', { cx: 4, cy: 7, r: 2 }),
      h('path', { d: 'M6 7h14m-4-4 4 4-4 4' }),
      h('circle', { cx: 20, cy: 17, r: 2 }),
      h('path', { d: 'M18 17H4m4-4-4 4 4 4' }));
    }
    const usageFields = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'];
    const compactTokens = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
    const requestClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const mainRequest = row => row.purpose === undefined || row.purpose === 'agent';
    const newestFirst = (a, b) => b.startedAt - a.startedAt;
    const wireName = attempt => attempt?.transport === 'websocket' ? 'WS' : attempt?.transport === 'sse' ? 'SSE' : '—';
    const isFallback = attempt => attempt?.transport === 'sse' && Boolean(attempt.fallbackReason);
    const transportName = attempt => isFallback(attempt) ? 'WS → SSE' : wireName(attempt);
    const nameOf = row => row.config.displayName || row.id;
    const routeOption = row => h('option', { key: row.id, value: row.id }, nameOf(row) === row.id ? row.id : nameOf(row) + ' · ' + row.id);
    const number = value => value?.toLocaleString() ?? '—';
    const attemptMode = (t, attempt) => t(attempt.delta ? 'deltaBadge' : 'fullBadge');

    function Notice({ useNotice, clear }) {
      const notice = useNotice();
      return notice ? h(Toast, { key: notice.sequence, text: notice.text, tone: notice.error ? undefined : 'success', onDone: () => clear(notice) }) : null;
    }

    function Tabs({ id, t, keys, value, change, label, disabled, className }) {
      return h(SegmentedControl, { id, label: t(label), value, onChange: change, disabled, className,
        options: keys.map(key => ({ value: key, label: t(key) })) });
    }

    function Fact({ label, children }) {
      return h('div', null, h('dt', null, label), h('dd', null, children));
    }

    function RequestCard({ row, t }) {
      const last = row.attempts.at(-1);
      const purpose = mainRequest(row) ? 'conversation' : row.purpose === 'session-title' ? 'titleRequest' : 'auxiliary';
      const style = isFallback(last) ? 'fallback' : last?.transport;
      return h('li', null, h('details', { className: 'ws-request', 'data-outcome': row.outcome },
        h('summary', { className: 'ws-request-trigger' },
          h('span', { className: 'ws-request-heading' },
            last && h('span', { className: 'ws-transport', 'data-transport': style }, transportName(last)),
            last && h('span', { className: 'ws-request-badge' }, attemptMode(t, last)),
            h('strong', { className: 'ws-request-model' }, row.model),
            h('span', { className: 'ws-request-purpose', 'data-purpose': purpose }, t(purpose)),
            row.outcome !== 'success' && h('span', { className: 'ws-request-badge', 'data-outcome': row.outcome }, t(row.outcome))),
          h('time', { className: 'ws-request-time', dateTime: new Date(row.startedAt).toISOString() }, requestClock.format(row.startedAt)),
          h('span', { className: 'ws-request-gateway' }, h('span', null, t('requestGateway')), row.provider),
          h('span', { className: 'ws-request-meta' },
            h('span', null, t('requestReasoning'), ' ', h('strong', null, last?.sentReasoningEffort ?? '—')),
            h('span', null, t('shortBody'), ' ', h('strong', null, last ? (last.delta ? t('deltaBody') + ' · ' : '') + bytes(last.requestBytes) : '—'))),
          h('span', { className: 'ws-usage' }, usageFields.map(key => {
            const count = row.usage?.[key];
            return h('span', { key, className: 'ws-metric' }, h('span', null, t(key)), ' ', h('strong', null, count == null ? '—' : compactTokens.format(count)));
          })),
          h('span', { className: 'ws-sr' }, t('requestDetails'))),
        h('div', { className: 'ws-attempts' },
          h('dl', { className: 'ws-facts ws-detail-facts' },
            h(Fact, { label: t('outcome') }, t(row.outcome), row.code ? ' · ' + row.code : '', row.providerErrorCode ? ' · ' + row.providerErrorCode : ''),
            h(Fact, { label: t('session') }, row.sessionId ?? '—'),
            h(Fact, { label: t('purpose') }, mainRequest(row) ? t('conversation') : row.purpose),
            h(Fact, { label: t('requestedReasoningEffort') }, row.requestedReasoningEffort ?? t('notSpecified'))),
          h('h4', null, t('attempts'), ' (', row.attempts.length, ')'),
          row.attempts.length === 0 ? h('p', null, t('noAttempts')) : h('ol', { className: 'ws-attempt-list' }, row.attempts.map((attempt, index) => {
            const comparison = attempt.continuationComparison;
            const difference = comparison?.firstDifference;
            return h('li', { key: index },
              h('strong', null, transportName(attempt), ' · ', attemptMode(t, attempt), attempt.transport === 'websocket' ? ' · ' + t(attempt.reused ? 'reused' : 'newConnection') : ''),
              h('dl', { className: 'ws-facts ws-detail-facts' },
                h(Fact, { label: t('requestBody') }, bytes(attempt.requestBytes)),
                h(Fact, { label: t('baseline') }, bytes(attempt.fullBytes)),
                h(Fact, { label: t('sentReasoningEffort') }, attempt.sentReasoningEffort ?? t('notSent')),
                h(Fact, { label: t('maxOutputTokens') }, number(attempt.maxOutputTokens)),
                attempt.fallbackReason && h(Fact, { label: t('fallbackReason') }, attempt.fallbackReason),
                attempt.resetReason && h(Fact, { label: t('resetReason') }, t(attempt.resetReason)),
                comparison && h(Fact, { label: t('historyLengths') }, t(comparison.kind), ' · ', comparison.inputLength, ' / ', comparison.previousInputLength, ' + ', comparison.previousOutputLength),
                difference && h(Fact, { label: t('firstDifference') }, difference.index + 1, ' · ', t(difference.section), ' · ', difference.previousType, ' → ', difference.currentType),
                difference?.fields?.length > 0 && h(Fact, { label: t('changedFields') }, difference.fields.map(field => field.name + ' (' + t(field.previousPresent ? 'fieldPresent' : 'fieldAbsent') + ' → ' + t(field.currentPresent ? 'fieldPresent' : 'fieldAbsent') + ')').join(', '))));
          })))));
    }

    function Recent({ state, t, busy, refresh, error }) {
      const [filter, setFilter] = useState('');
      const [withAuxiliary, setWithAuxiliary] = useState(true);
      const active = state.providers.some(row => row.id === filter) ? filter : '';
      const rows = state.diagnostics.requests.filter(row => (!active || row.provider === active) && (withAuxiliary || mainRequest(row)))
        .sort(newestFirst).slice(0, 5);
      return h('div', { className: 'ws-recent', 'aria-busy': busy },
        h('div', { className: 'ws-recent-head' }, h('h3', null, t('recent')), h('span', null, t('latestFive'))),
        error && h('div', { className: 'ws-notice ws-error ws-recent-filter', role: 'alert' }, error,
          h(Button, { variant: 'outline', onClick: refresh, disabled: busy }, t('refreshRequests'))),
        rows.length > 0 ? h('ul', { className: 'ws-requests' }, rows.map(row => h(RequestCard, { key: row.id, row, t })))
          : !busy && h('p', { className: 'ws-card' }, t(active || !withAuxiliary ? 'noMatchingRequests' : 'noRequests')),
        h('p', { className: 'ws-recent-note' }, t('requestUsageHelp')),
        h('details', { className: 'ws-recent-options' }, h('summary', null, t('requestOptions')),
          h('div', { className: 'ws-recent-filter' },
            h('select', { 'aria-label': t('filterRoute'), value: active, onChange: e => setFilter(e.target.value) },
              h('option', { value: '' }, t('allRoutes')), state.providers.map(routeOption)),
            h('label', { className: 'ws-checkbox' }, h('input', { type: 'checkbox', checked: withAuxiliary, onChange: e => setWithAuxiliary(e.target.checked) }), t('includeAuxiliary')),
            h(Button, { variant: 'outline', onClick: refresh, disabled: busy }, t('refreshRequests')))));
    }

    function Page({ t, invoke, notify }) {
      const [state, setState] = useState(null);
      const [provider, setProvider] = useState('');
      const [creating, setCreating] = useState(true);
      const [draft, setDraft] = useState(null);
      const [revision, setRevision] = useState('');
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [view, setView] = useState('settingsView');
      const [tab, setTab] = useState('connections');
      const [importing, setImporting] = useState(false);
      const [source, setSource] = useState('');
      const [target, setTarget] = useState('');
      const [newTarget, setNewTarget] = useState('');
      const [importRevision, setImportRevision] = useState('');
      const [modelPicks, setModelPicks] = useState(null);
      const [key, setKey] = useState('');
      const [headers, setHeaders] = useState('');
      const [available, setAvailable] = useState([]);
      const [checkModel, setCheckModel] = useState('');
      const [confirmation, setConfirmation] = useState('');
      const [modelKeys, setModelKeys] = useState([]);
      const nextModelKey = useRef(0);
      const focusAfterImport = useRef(false);
      const focusImportTitle = useRef(false);
      const focusNewModel = useRef(null);
      const mobileRoute = useRef(null);
      const desktopRail = useRef(null);
      const routeArea = useRef(null);
      const id = useId();
      const navId = id + '-views';
      const settingsId = id + '-settings';

      const loadDraft = (row, snapshot) => {
        setCreating(!row); setProvider(row?.id ?? ''); setDraft(row ? clone(row.config) : blank());
        setModelKeys(row?.config.models.map(() => ++nextModelKey.current) ?? []);
        setRevision(snapshot.revision); setDirty(false); setError(''); setHeaders(''); setKey('');
        setAvailable([]); setCheckModel(row?.config.models[0]?.id ?? ''); setConfirmation('');
      };
      const select = next => {
        if ((!creating && provider === next) || (creating && !next && !dirty && !importing)) return;
        if (dirty && !window.confirm(t('switchConfirm'))) return;
        loadDraft(state.providers.find(row => row.id === next), state);
        setImporting(false); setTab('connections');
      };
      const read = async (mode = 'settings') => {
        setBusy(true);
        try {
          const next = await invoke({ action: 'describe' }); setState(next); setError('');
          if (mode === 'recent') return;
          if (importing) { setImportRevision(next.revision); setModelPicks(null); return; }
          if (!draft || (!dirty && !creating)) loadDraft(next.providers.find(row => row.id === provider) ?? next.providers[0], next);
        } catch (e) { setError(t(failureLabel[e.code] ?? 'failed')); }
        finally { setBusy(false); }
      };
      useEffect(() => {
        let mounted = true;
        invoke({ action: 'describe' }).then(next => { if (mounted) { setState(next); loadDraft(next.providers[0], next); } })
          .catch(() => { if (mounted) setError(t('failed')); });
        return () => { mounted = false; };
      }, []);
      useEffect(() => {
        const region = routeArea.current;
        if (!region || typeof ResizeObserver === 'undefined') return;
        let lastRouteControl;
        const remember = event => { lastRouteControl = event.target; };
        const forget = event => { if (!region.contains(event.target) && event.target !== region.ownerDocument.body) lastRouteControl = undefined; };
        region.addEventListener('focusin', remember);
        region.ownerDocument.addEventListener('focusin', forget);
        const observer = new ResizeObserver(() => {
          if (!lastRouteControl || lastRouteControl.getClientRects().length > 0) return;
          const focused = region.ownerDocument.activeElement;
          if (focused && focused !== region.ownerDocument.body && focused !== lastRouteControl) return;
          if (mobileRoute.current?.getClientRects().length > 0) mobileRoute.current.focus();
          else desktopRail.current?.querySelector('[aria-current="true"], :scope > button:last-of-type')?.focus();
        });
        observer.observe(region);
        return () => { observer.disconnect(); region.removeEventListener('focusin', remember); region.ownerDocument.removeEventListener('focusin', forget); };
      }, [Boolean(state), view, importing]);
      const change = (name, value) => { setDraft(previous => ({ ...previous, [name]: value })); setDirty(true); setError(''); };
      const modelChange = (index, name, value) => change('models', draft.models.map((model, at) => at === index ? { ...model, [name]: value } : model));
      const discoveryChange = (name, value) => change('discovery', { ...draft.discovery, [name]: value });
      const closeImport = () => { focusAfterImport.current = true; setImporting(false); setTab('models'); setError(''); };
      const action = async (input, success, keepDraft = false) => {
        setBusy(true); setError('');
        try {
          const result = await invoke(input);
          const next = result.state ?? result;
          if (next.providers) {
            setState(next);
            if (!keepDraft) loadDraft(next.providers.find(row => row.id === input.provider) ?? next.providers[0], next);
          }
          if (result.models) setAvailable(result.models.map(model => model.id));
          if (result.discovery === 'disabled') { setError(t('discoveryDisabled')); return; }
          if (result.discovery === 'failed') { notify(t('discoveryFailed'), true); return; }
          if (success) notify(t(success));
          return result;
        } catch (e) { const text = t(failureLabel[e.code] ?? 'failed'); setError(text); notify(text, true); }
        finally { setBusy(false); }
      };
      const save = () => {
        if (creating && state.providers.some(row => row.id === provider)) { setError(t('routeConflict')); return; }
        const config = clone(draft);
        if (headers.trim()) { try { config.headers = JSON.parse(headers); } catch (_error) { setError(t('invalidJson')); return; } }
        if (config.retryPolicy?.mode === 'always') { setError(t('failed')); return; }
        action({ action: 'save', provider, config, revision, create: creating }, 'saved');
      };
      const button = (label, fn, options = {}) => h(Button, { variant: 'outline', disabled: busy, onClick: fn, ...options }, t(label));
      if (!state) return h('section', { className: 'ws-gateway', 'aria-label': t('title') }, error
        ? h('p', { role: 'alert' }, error, ' ', button('refresh', () => read()))
        : h('div', { className: 'ws-loading', role: 'status', 'aria-label': t('loading') }, h('span', { className: 'ws-spinner' })));

      const locked = busy || !state.writable;
      const selected = creating ? undefined : state.providers.find(row => row.id === provider);
      const data = draft;
      const routeRequests = state.diagnostics.requests.filter(row => row.provider === selected?.id);
      const latest = [...routeRequests].sort(newestFirst).find(row => row.attempts.length > 0)?.attempts.at(-1);
      const runtime = state.diagnostics.routes.find(row => row.provider === selected?.id);
      const duplicateId = creating && state.providers.some(row => row.id === provider);
      const refreshBlock = !selected ? null : dirty ? 'discoveryUnsaved' : !selected.config.discover ? 'discoveryDisabled' : null;
      const field = (label, value, update, type = 'text', options = {}) => h('label', { key: label, className: 'ws-field' },
        h('span', null, t(label)), h('input', { type, value: value ?? '', disabled: locked,
          min: type === 'number' ? 0 : undefined, step: type === 'number' ? 1 : undefined,
          onChange: e => {
            if (type !== 'number') { update(e.target.value); return; }
            const n = Number(e.target.value);
            if (!Number.isSafeInteger(n) || n < 0) { setError(t('invalidNumber')); return; }
            update(n);
          }, ...options }));
      const toggle = (label, checked, update, disabled = false, hint) => h('div', { className: 'ws-toggle-row' },
        h('span', null, t(label), hint && h('small', null, t(hint))),
        h(Switch, { label: t(label), checked: !!checked, onChange: update, disabled: locked || disabled }));
      const renderCapabilities = (model, update) => h('div', { className: 'ws-stage' },
        toggle('imageInput', model.input?.includes('image'), on => update('input', on ? ['text', 'image'] : ['text'])),
        h('fieldset', { className: 'ws-efforts' }, h('legend', null, t('efforts')), efforts.map(effort => h('label', { key: effort, className: 'ws-checkbox' },
          h('input', { type: 'checkbox', checked: model.reasoningEfforts?.includes(effort) ?? false, disabled: locked,
            onChange: e => update('reasoningEfforts', e.target.checked ? [...model.reasoningEfforts, effort] : model.reasoningEfforts.filter(value => value !== effort)) }), effort))));
      const bindImportButton = node => {
        if (node && focusAfterImport.current) { focusAfterImport.current = false; node.focus(); }
      };
      const openImport = () => {
        focusImportTitle.current = true;
        setSource(''); setTarget(selected?.id ?? ''); setNewTarget(''); setModelPicks(null);
        setImportRevision(state.revision); setError(''); setImporting(true);
      };
      const capacity = (label, detail) => h('div', { className: 'ws-capacity' },
        h('span', { className: 'ws-muted ws-small' }, t(label)), h('strong', { className: 'ws-mono' }, number(detail.value)),
        h(Tag, { tone: detail.source === 'explicit-model' ? 'neutral' : 'info' }, t(detail.source)));
      const candidate = state.sources.find(row => row.provider === source);
      const importTarget = state.providers.find(row => row.id === target);
      const existingModels = new Set(importTarget?.config.models.map(model => model.id));
      const picks = modelPicks?.fingerprint === candidate?.fingerprint ? modelPicks?.ids ?? [] : [];
      const additions = candidate?.preview?.filter(model => picks.includes(model.id) && !existingModels.has(model.id)).map(model => model.id) ?? [];
      const submitImport = async () => {
        if (dirty && !window.confirm(t('switchConfirm'))) return;
        const input = { source, sourceFingerprint: candidate.fingerprint, provider: importTarget?.id ?? newTarget, revision: importRevision };
        const result = importTarget
          ? await action({ ...input, action: 'merge-models', models: additions }, 'modelsMerged')
          : await action({ ...input, action: 'import' }, 'imported');
        if (result) closeImport();
      };
      const importView = importing && h('div', { className: 'ws-stage' },
        h('div', { className: 'ws-row' },
          h('div', null, h('h3', { tabIndex: -1, ref: node => { if (node && focusImportTitle.current) { focusImportTitle.current = false; node.focus(); } } }, t('importTitle')),
            h('p', null, t('importHelp'))),
          h('div', { className: 'ws-actions' }, button('refresh', () => read(), { variant: 'ghost' }), button('backToModels', closeImport, { variant: 'ghost' }))),
        h('div', { className: 'ws-card' }, h('h4', null, t('importRouteStep')),
          h('div', { className: 'ws-grid' },
            h('label', { className: 'ws-field' }, h('span', null, t('source')),
              h('select', { value: source, disabled: locked, onChange: e => {
                setSource(e.target.value); setModelPicks(null); setError('');
                if (!target) setNewTarget(e.target.value ? e.target.value + '-ws' : '');
              } }, h('option', { value: '' }, t('choose')), state.sources.map(row => h('option', { key: row.provider, value: row.provider }, row.displayName)))),
            h('label', { className: 'ws-field' }, h('span', null, t('importTarget')),
              h('select', { value: target, disabled: locked, onChange: e => {
                setTarget(e.target.value); setModelPicks(null); setError('');
                if (!e.target.value) setNewTarget(source ? source + '-ws' : '');
              } }, state.providers.map(routeOption), h('option', { value: '' }, t('newRoute'))))),
          !importTarget && field('target', newTarget, value => { setNewTarget(value); setError(''); })),
        candidate?.eligible && h('div', { className: 'ws-card' }, h('h4', null, t('importReviewStep')),
          h('p', null, t('candidateHelp')),
          h('ul', { className: 'ws-import-models' }, candidate.preview?.map(model => {
            const exists = existingModels.has(model.id);
            return h('li', { key: model.id, className: 'ws-import-model' },
              importTarget ? h('label', { className: 'ws-checkbox ws-model-name' }, h('input', {
                type: 'checkbox', checked: picks.includes(model.id), disabled: locked || exists,
                onChange: e => setModelPicks({ fingerprint: candidate.fingerprint, ids: e.target.checked ? [...picks, model.id] : picks.filter(value => value !== model.id) }),
              }), h('span', { className: 'ws-mono' }, model.id), exists && h(Tag, { tone: 'neutral' }, t('importAlreadyPresent')))
                : h('strong', { className: 'ws-mono ws-model-name' }, model.id),
              capacity('contextWindow', model.contextWindow), capacity('maxTokens', model.maxTokens));
          })), importTarget && h('p', { className: 'ws-notice ws-info' }, t('mergePreserve'))),
        candidate && !candidate.eligible && h('p', { className: 'ws-notice ws-warn', role: 'status' },
          t(sourceReasonLabel[candidate.reason] ?? 'ineligible'), candidate.model && ' · ' + candidate.model, candidate.field && ' · ' + t(candidate.field)),
        h('div', { className: 'ws-footer' }, importTarget && h('span', { className: 'ws-small ws-muted' }, t('selectedModels'), ': ', additions.length),
          h('div', { className: 'ws-actions' }, button('cancel', closeImport, { variant: 'ghost' }),
            button(importTarget ? 'mergeModels' : 'import', submitImport, { variant: 'primary', disabled: locked || !candidate?.eligible || (importTarget ? additions.length === 0 : !newTarget) }))));

      const status = selected && h('dl', { className: 'ws-facts ws-status' },
        h(Fact, { label: t('savedPolicy') }, t(selected.config.transport === 'sse' ? 'policySse' : 'policyAuto')),
        h(Fact, { label: t('actual') }, latest ? transportName(latest) + ' · ' + attemptMode(t, latest) : t('unverified')),
        h(Fact, { label: t('credentialsStatus') }, h(Tag, { tone: selected.credential.configured ? 'success' : 'warning' }, t(selected.credential.configured ? 'keyConfigured' : 'keyMissing'))));
      const activeAttempts = routeRequests.flatMap(row => row.attempts);
      const uploaded = activeAttempts.reduce((n, attempt) => n + attempt.requestBytes, 0);
      const baseline = activeAttempts.reduce((n, attempt) => n + attempt.fullBytes, 0);
      const connectionView = () => h(React.Fragment, null,
        status,
        h('section', { className: 'ws-card' }, h('h4', null, t('endpointCredentials')),
          h('div', { className: 'ws-grid' },
            field('id', provider, value => { setProvider(value); setDirty(true); setError(''); }, 'text', { readOnly: !creating }),
            field('displayName', data.displayName, value => change('displayName', value)),
            field('baseURL', data.baseURL, value => change('baseURL', value), 'url'),
            field('apiKeyEnv', data.apiKeyEnv, value => change('apiKeyEnv', value))),
          selected && h('details', { className: 'ws-inline-details' }, h('summary', null, t('changeKey')),
            h('div', { className: 'ws-secret' }, field('newKey', key, setKey, 'password', { autoComplete: 'new-password' }),
              button('setKey', async () => { if (await action({ action: 'credential', provider, key }, 'keySaved', true)) setKey(''); }, { disabled: locked || dirty || !key })),
            h('p', { className: 'ws-small' }, t('keyHelp')))),
        h('section', { className: 'ws-card' }, h('h4', null, t('transportOptions')),
          h('label', { className: 'ws-field' }, h('span', null, t('transport')),
            h('select', { value: data.transport, disabled: locked, onChange: e => change('transport', e.target.value) },
              h('option', { value: 'auto' }, t('auto')), h('option', { value: 'sse' }, t('sse')))),
          h('label', { className: 'ws-field' }, h('span', null, t('requestFormat')),
            h('select', { value: data.requestFormat ?? 'standard', disabled: locked, onChange: e => change('requestFormat', e.target.value) },
              h('option', { value: 'standard' }, t('requestFormatStandard')), h('option', { value: 'codex' }, t('requestFormatCodex')),
              h('option', { value: 'codex-instructions' }, t('requestFormatCodexInstructions')))),
          h('label', { className: 'ws-field' }, h('span', null, t('clientMetadata')),
            h('select', { value: data.clientMetadata ?? 'off', disabled: locked, onChange: e => change('clientMetadata', e.target.value) },
              h('option', { value: 'off' }, t('clientMetadataOff')), h('option', { value: 'codex' }, t('clientMetadataCodex')))),
          h('p', { className: 'ws-small' }, t('clientMetadataHelp')),
          h('div', { className: 'ws-grid' },
            toggle('reuseConnection', data.reuseConnection, value => change('reuseConnection', value), data.transport === 'sse', 'reuseHint'),
            toggle('continuation', data.continuation, value => change('continuation', value), data.transport === 'sse' || !data.reuseConnection, 'deltaHint')),
          h('p', { className: 'ws-small' }, t('continuationHelp'))),
        h('details', { className: 'ws-disclosure' }, h('summary', null, t('advanced'), ' ', h('span', { className: 'ws-muted ws-small' }, t('advancedHint'))),
          h('div', { className: 'ws-stage' },
            h('div', { className: 'ws-grid' },
              field('fallbackAfterFailures', data.fallbackAfterFailures, value => change('fallbackAfterFailures', value), 'number'),
              field('fallbackCooldownMs', data.fallbackCooldownMs, value => change('fallbackCooldownMs', value), 'number'),
              field('retryCount', data.retryPolicy?.maxRetries ?? 5, value => change('retryPolicy', { mode: 'normal', maxRetries: value }), 'number')),
            h('p', null, t('retryHelp')),
            h('div', { className: 'ws-grid' }, advanced.map(name => field(name, data[name], value => change(name, value), 'number'))),
            toggle('supportsMaxOutputTokens', data.supportsMaxOutputTokens ?? true, value => change('supportsMaxOutputTokens', value)),
            data.headersConfigured && h('p', null, t('headersConfigured')),
            h('label', { className: 'ws-field' }, h('span', null, t('headers')), h('textarea', { value: headers, disabled: locked, spellCheck: false, onChange: e => { setHeaders(e.target.value); setDirty(true); setError(''); } })),
            h('p', null, t('headersHelp')),
            selected && h('section', { className: 'ws-runtime' }, h('h4', null, t('diagnostics')),
              h('dl', { className: 'ws-facts ws-detail-facts' },
                h(Fact, { label: t('activeConnections') }, (runtime?.pool.connections ?? 0) + ' / ' + (runtime?.pool.busy ?? 0)),
                h(Fact, { label: t('requestBody') }, bytes(uploaded)), h(Fact, { label: t('baseline') }, bytes(baseline)),
                h(Fact, { label: t('reduction') }, baseline ? ((1 - uploaded / baseline) * 100).toFixed(1) + '%' : '—')),
              h('p', { className: 'ws-small' }, t('reductionHelp')),
              runtime?.circuit.sseUntil > Date.now() && h('p', { className: 'ws-warn' }, t('cooling'), ' · ', Math.ceil((runtime.circuit.sseUntil - Date.now()) / 1000), ' ', t('seconds')),
              runtime?.circuit.probing && h('p', { role: 'status' }, t('probe')),
              h('div', { className: 'ws-row' }, h('p', { className: 'ws-small' }, t('resetHelp')),
                button('reset', () => action({ action: 'reset', provider }, 'resetDone', true)))),
            selected && h('div', { className: 'ws-row' },
              h('p', { className: 'ws-small' }, t('deleteHelp')),
              button('delete', () => { if (window.confirm(t('deleteConfirm'))) action({ action: 'delete', provider, revision }, 'deleted'); }, { disabled: locked, className: 'ws-danger' })))));

      const capabilityRows = [...data.models, ...(data.discover ? [data.discovery] : [])];
      const usableEfforts = efforts.filter(effort => capabilityRows.every(model => model.reasoningEfforts.includes(effort)));
      if (capabilityRows.every(model => model.reasoningEfforts.length === 0)) usableEfforts.unshift('off');
      const addModel = () => {
        const modelKey = ++nextModelKey.current;
        focusNewModel.current = modelKey;
        setModelKeys(previous => [...previous, modelKey]);
        change('models', [...data.models, blankModel()]);
      };
      const removeModel = index => { setModelKeys(previous => previous.filter((_, at) => index !== at)); change('models', data.models.filter((_, at) => index !== at)); };
      const modelView = () => h(React.Fragment, null,
        h('section', { className: 'ws-card' }, h('h4', null, t('reasoning')),
          h('label', { className: 'ws-field' }, h('span', { className: 'ws-sr' }, t('reasoning')),
            h('select', { value: data.reasoning ?? '', disabled: locked, onChange: e => change('reasoning', e.target.value || undefined) },
              h('option', { value: '' }, t('providerDefault')),
              [...new Set([...usableEfforts, ...(data.reasoning ? [data.reasoning] : [])])].map(effort => h('option', { key: effort, value: effort }, effort)))),
          h('p', { className: 'ws-small' }, t('reasoningHelp'))),
        h('section', { className: 'ws-card' },
          h('div', { className: 'ws-row' }, h('h4', null, t('configuredModels')),
            h('div', { className: 'ws-actions' }, button('openImport', openImport, { ref: bindImportButton, disabled: locked }), button('addModel', addModel, { disabled: locked }))),
          h('p', { className: 'ws-small' }, t('modelHelp')),
          data.models.length === 0 && h('p', null, t('noModels')),
          h('ul', { className: 'ws-models' }, data.models.map((model, index) => h('li', { key: modelKeys[index] },
            h('details', { className: 'ws-inline-details', ref: node => {
              if (node && focusNewModel.current === modelKeys[index]) {
                focusNewModel.current = null; node.open = true; node.querySelector('summary').focus();
              }
            } },
              h('summary', null, h('strong', { className: 'ws-mono' }, model.id || t('modelId')), ' ',
                h('span', { className: 'ws-muted ws-small' }, model.reasoningEfforts.join(' · '))),
              h('div', { className: 'ws-stage' }, h('div', { className: 'ws-grid' },
                field('modelId', model.id, value => modelChange(index, 'id', value)),
                field('displayName', model.name, value => modelChange(index, 'name', value)),
                field('contextWindow', model.contextWindow, value => modelChange(index, 'contextWindow', value), 'number'),
                field('maxTokens', model.maxTokens, value => modelChange(index, 'maxTokens', value), 'number')),
                renderCapabilities(model, (name, value) => modelChange(index, name, value)),
                h('div', { className: 'ws-actions' }, button('removeModel', () => removeModel(index), { disabled: locked, className: 'ws-danger' })))))))),
        h('section', { className: 'ws-card' }, h('h4', null, t('upstreamModels')),
          toggle('discover', data.discover, value => change('discover', value)),
          h('p', { className: 'ws-small' }, t('discoveryHelp')),
          h('div', { className: 'ws-row' }, button('refreshModels', () => action({ action: 'refresh', provider, revision }, null, true), { disabled: busy || !selected || Boolean(refreshBlock) }),
            refreshBlock && h('p', { role: 'status' }, t(refreshBlock))),
          runtime?.discoveryError && h('p', { className: 'ws-notice ws-warn', role: 'status' }, t('discoveryFailed')),
          available.length > 0 && h('p', { className: 'ws-mono ws-small' }, t('available'), ': ', available.join(', ')),
          h('details', { className: 'ws-inline-details' }, h('summary', null, t('discoveryTemplate')),
            h('div', { className: 'ws-stage' }, h('div', { className: 'ws-grid' },
              ['contextWindow', 'maxTokens', 'ttlMs', 'timeoutMs', 'maxResponseBytes', 'maxModels'].map(name => field(name, data.discovery[name], value => discoveryChange(name, value), 'number'))),
              renderCapabilities(data.discovery, discoveryChange),
              h('label', { className: 'ws-field' }, h('span', null, t('exclude')), h('textarea', { value: data.discovery.exclude.join('\n'), disabled: locked, onChange: e => discoveryChange('exclude', e.target.value.split('\n').map(value => value.trim()).filter(Boolean)) }))))),
        selected && h('details', { className: 'ws-disclosure' }, h('summary', null, t('modelVerification')),
          h('div', { className: 'ws-stage' }, h('p', null, t('verifyHelp')),
            h('label', { className: 'ws-field' }, h('span', null, t('verifyModel')),
              h('select', { value: checkModel, disabled: busy, onChange: e => setCheckModel(e.target.value) },
                h('option', { value: '' }, t('chooseModel')), selected.config.models.map(model => h('option', { key: model.id, value: model.id }, model.id)))),
            h('div', { className: 'ws-actions' }, button('verify', async () => {
              if (!window.confirm(t('verifyConfirm'))) return;
              const result = await action({ action: 'verify', provider, model: checkModel, allowBillable: true }, null, true);
              if (result) setConfirmation(t(result.websocket && result.delta ? 'verified' : 'notIncremental'));
            }, { disabled: busy || !checkModel || dirty })), confirmation && h('p', { role: 'status' }, confirmation))));

      return h('section', { className: 'ws-gateway', 'aria-label': t('title') },
        h('header', { className: 'ws-heading' }, h('h2', null, t('title')), h('p', null, t('intro'))),
        h(Tabs, { id: navId, t, keys: ['settingsView', 'recent'], value: view, label: 'title', disabled: busy,
          className: 'ws-top-tabs', change: next => { setError(''); setView(next); if (next === 'recent' && view !== next) void read('recent'); } }),
        state.diagnostics.cleanupFailures?.length > 0 && h('p', { className: 'ws-notice ws-error', role: 'alert' }, t('cleanupFailure')),
        view === 'recent' ? h('div', { role: 'tabpanel', id: navId + '-recent-panel', 'aria-labelledby': navId + '-recent' },
          h(Recent, { state, t, busy, error, refresh: () => read('recent') }))
          : h('div', { className: 'ws-settings-layout', role: 'tabpanel', id: navId + '-settingsView-panel', 'aria-labelledby': navId + '-settingsView', ref: routeArea },
            h('aside', { className: 'ws-route-rail', ref: desktopRail, 'aria-label': t('routes') }, h('div', { className: 'ws-row ws-muted ws-small' }, t('routes'), h('span', null, state.providers.length)),
              state.providers.map(row => h(Button, { key: row.id, variant: 'ghost', disabled: busy, 'aria-current': row.id === selected?.id ? 'true' : undefined,
                className: 'ws-route-choice', onClick: () => select(row.id) },
                h('strong', { className: 'ws-mono' }, nameOf(row)), h('span', { className: 'ws-muted ws-small' }, t(row.config.transport === 'sse' ? 'policySse' : 'policyAuto')))),
              button('add', () => select(''), { className: 'ws-route-add', disabled: locked })),
            h('div', { className: 'ws-route-mobile' },
              h('select', { ref: mobileRoute, value: selected?.id ?? '', 'aria-label': t('route'), disabled: busy, onChange: e => select(e.target.value) },
                h('option', { value: '', disabled: true }, t('newRoute')), state.providers.map(routeOption)),
              button('add', () => select(''), { disabled: locked })),
            h('div', { className: 'ws-stage' },
              !state.writable && h('p', { className: 'ws-notice ws-warn' }, t('readOnly')),
              selected?.sourceChanged && !importing && h('p', { className: 'ws-notice ws-warn' }, t('sourceChanged')),
              !state.providers.length && !importing && h('p', null, t('empty')),
              duplicateId && !importing && h('p', { className: 'ws-notice ws-error', role: 'alert' }, t('routeConflict')),
              error && h('p', { className: 'ws-notice ws-error', role: 'alert' }, error),
              importing ? importView : h(React.Fragment, null,
                h('div', { className: 'ws-row' }, h('h3', null, selected ? nameOf(selected) : t('newRoute')),
                  button('refresh', () => read(), { variant: 'ghost' })),
                h(Tabs, { id: settingsId, t, keys: ['connections', 'models'], value: tab, change: setTab, label: 'settingsView', disabled: busy, className: 'ws-sub-tabs' }),
                h('div', { className: 'ws-stage', role: 'tabpanel', id: settingsId + '-' + tab + '-panel', 'aria-labelledby': settingsId + '-' + tab },
                  tab === 'connections' ? connectionView() : modelView()),
                h('div', { className: 'ws-footer' }, h('span', { className: 'ws-small ws-muted', role: 'status' }, dirty ? t('unsaved') : ''),
                  h('div', { className: 'ws-actions' }, button('discard', () => loadDraft(selected, state), { disabled: busy || !dirty }),
                    button('save', save, { variant: 'primary', disabled: locked || duplicateId || !provider || !data.baseURL || !data.apiKeyEnv })))))));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const namespace = 'websocket-gateway';
        for (const [locale, dict] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register(namespace, locale, dict));
        let notice;
        const listeners = new Set();
        const source = { getSnapshot: () => notice, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
        const publish = next => { notice = next; for (const listener of listeners) listener(); };
        const notify = (text, error = false) => publish({ text, error, sequence: (notice?.sequence ?? 0) + 1 });
        const clear = expected => { if (notice === expected) publish(undefined); };
        const lifetime = new AbortController();
        ctx.effect(() => () => { lifetime.abort(); listeners.clear(); });
        const invoke = async input => {
          const response = await fetch(new URL('./api/dsh-websocket', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: lifetime.signal });
          const result = await response.json();
          if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
          return result.value;
        };
        const t = ctx.locale.bind(namespace);
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-websocket', order: 13, label: () => t('title'), locale: namespace, inject: () => ({ invoke, notify }) }, Page));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'dsh-websocket' }, WebSocketIcon));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-websocket-notices', order: 100, inject: () => ({ clear, hooks: { notice: source } }) }, Notice));
        ctx.effect(() => {
          const style = document.createElement('style'); style.textContent = styles; document.head.appendChild(style);
          return () => style.remove();
        });
      },
    };
  },
});
