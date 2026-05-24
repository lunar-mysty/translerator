import { useState, useCallback, useEffect, useRef } from 'react'
import { useI18n, UI_LOCALES, languageNames } from './i18n.jsx'
import { APP_VERSION } from './version.js'

const STORAGE_KEY = 'translerator-state'
const CLIENT_ID_STORAGE_KEY = 'translerator-client-id'
const HARDWARE_ID_STORAGE_KEY = 'translerator-hardware-id'
const CLIENT_ID_COOKIE_NAME = 'translerator_client_id'

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const MAX_GROW_HEIGHT = 500
const AUTO_TRANSLATE_DELAY = 1000
const MODEL_MODES = ['fast', 'precise', 'super']
const MODEL_MODE_ALIASES = {
  accurate: 'precise',
}
const MODEL_MODE_DETAILS = {
  fast: {
    labelKey: 'fastMode',
    fallbackLabel: 'Fast',
    model: 'Claude Haiku 4.5',
    limit: 100,
  },
  precise: {
    labelKey: 'preciseMode',
    fallbackLabel: 'Precise',
    model: 'Claude Sonnet 4.6',
    limit: 50,
  },
  super: {
    labelKey: 'superMode',
    fallbackLabel: 'Super',
    model: 'Claude Opus 4.7',
    limit: 25,
  },
}
const APP_MODES = ['standard', 'conversation']
const CONVERSATION_SIDES = ['user', 'other']
const LONG_MESSAGE_CHAR_LIMIT = 420
const LONG_MESSAGE_LINE_LIMIT = 8
const LONG_MESSAGE_PREVIEW_HEIGHT = 168

function createPersistentId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function readCookie(name) {
  if (typeof document === 'undefined') return ''
  const cookie = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`))

  if (!cookie) return ''
  try {
    return decodeURIComponent(cookie.slice(name.length + 1))
  } catch {
    return cookie.slice(name.length + 1)
  }
}

function writeCookie(name, value) {
  if (typeof document === 'undefined') return
  const maxAge = 60 * 60 * 24 * 365
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`
}

function loadPersistentId(storageKey, cookieName, prefix) {
  const cookieValue = cookieName ? readCookie(cookieName) : ''

  try {
    const stored = localStorage.getItem(storageKey)
    const id = stored || cookieValue || createPersistentId(prefix)
    localStorage.setItem(storageKey, id)
    if (cookieName) writeCookie(cookieName, id)
    return id
  } catch {
    const id = cookieValue || createPersistentId(prefix)
    if (cookieName) writeCookie(cookieName, id)
    return id
  }
}

function getClientIdentity() {
  const clientId = loadPersistentId(CLIENT_ID_STORAGE_KEY, CLIENT_ID_COOKIE_NAME, 'client')
  const hardwareId = loadPersistentId(HARDWARE_ID_STORAGE_KEY, '', 'hardware')
  const nav = typeof navigator === 'undefined' ? {} : navigator
  const screenInfo = typeof screen === 'undefined'
    ? undefined
    : {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio,
    }

  return {
    clientId,
    hardwareId,
    userAgent: nav.userAgent,
    platform: nav.platform,
    vendor: nav.vendor,
    language: nav.language,
    languages: Array.isArray(nav.languages) ? nav.languages : undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    maxTouchPoints: nav.maxTouchPoints,
    cookieEnabled: nav.cookieEnabled,
    doNotTrack: nav.doNotTrack,
    screen: screenInfo,
  }
}

function normalizeModelMode(mode) {
  const normalized = MODEL_MODE_ALIASES[mode] || mode
  return MODEL_MODES.includes(normalized) ? normalized : 'fast'
}

function getModelModeLabel(t, mode) {
  const details = MODEL_MODE_DETAILS[mode]
  return t[details.labelKey] || (mode === 'precise' ? t.accurateMode : '') || details.fallbackLabel
}

function formatQuotaReset(t, resetAt, now, template) {
  if (!resetAt) return t.modelWindowStartsOnUse || 'window starts on first request'

  const resetDate = new Date(resetAt)
  if (Number.isNaN(resetDate.getTime())) return t.modelWindowActive || 'window active'

  const msLeft = Math.max(0, resetDate.getTime() - now)
  const totalMinutes = Math.ceil(msLeft / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const relative = hours > 0
    ? `${hours}h ${minutes.toString().padStart(2, '0')}m`
    : `${minutes}m`
  const absolute = resetDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (template || t.modelResetTemplate || 'resets in {timeLeft} at {resetTime}')
    .replace('{timeLeft}', relative)
    .replace('{resetTime}', absolute)
}

function createConversationMessage(side = 'user', text = '') {
  const safeSide = CONVERSATION_SIDES.includes(side) ? side : 'user'
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    side: safeSide,
    text,
  }
}

function normalizeConversationMessages(saved) {
  if (Array.isArray(saved.conversationMessages)) {
    return saved.conversationMessages
      .filter((message) => (
        message &&
        CONVERSATION_SIDES.includes(message.side) &&
        typeof message.text === 'string'
      ))
      .map((message) => ({
        id: String(message.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        side: message.side,
        text: message.text,
      }))
  }

  const legacyMessages = []
  if (typeof saved.conversationContext === 'string' && saved.conversationContext.trim()) {
    legacyMessages.push(createConversationMessage('other', saved.conversationContext))
  }
  if (typeof saved.conversationReply === 'string' && saved.conversationReply.trim()) {
    legacyMessages.push(createConversationMessage('user', saved.conversationReply))
  }

  return legacyMessages
}

function isVeryLongConversationMessage(text) {
  return text.length > LONG_MESSAGE_CHAR_LIMIT || text.split('\n').length > LONG_MESSAGE_LINE_LIMIT
}

function resizeMessageTextarea(el, collapsed) {
  if (!el) return

  el.style.height = 'auto'
  const nextHeight = collapsed
    ? Math.min(el.scrollHeight, LONG_MESSAGE_PREVIEW_HEIGHT)
    : el.scrollHeight
  el.style.height = nextHeight + 'px'
  el.style.overflowY = collapsed ? 'hidden' : 'hidden'
}

function useAutoResize(value) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX_GROW_HEIGHT)
    el.style.height = next + 'px'
    el.style.overflowY = el.scrollHeight > MAX_GROW_HEIGHT ? 'auto' : 'hidden'
  }, [value])
  return ref
}

const CUSTOM = 'Custom'

const LANGUAGES = [
  'Auto-detect',
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Russian',
  'Japanese',
  'Korean',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Arabic',
  'Hindi',
  'Dutch',
  'Swedish',
  'Polish',
  'Turkish',
  'Vietnamese',
  'Thai',
  'Indonesian',
  'Greek',
  'Czech',
  'Romanian',
  'Hungarian',
  'Ukrainian',
  'Hebrew',
  'Danish',
  'Finnish',
  'Norwegian',
  CUSTOM,
]

const TARGET_LANGUAGES = LANGUAGES.filter((l) => l !== 'Auto-detect')

function Icon({ name, size = 18 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  const icons = {
    check: (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    ),
    clear: (
      <svg {...common}>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    ),
    copy: (
      <svg {...common}>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    ),
    globe: (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    settings: (
      <svg {...common}>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
    ticket: (
      <svg {...common}>
        <path d="M2 9a3 3 0 0 0 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 0 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2Z" />
        <path d="M13 5v2" />
        <path d="M13 17v2" />
        <path d="M13 11v2" />
      </svg>
    ),
    send: (
      <svg {...common}>
        <path d="M22 2 11 13" />
        <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      </svg>
    ),
    swap: (
      <svg {...common}>
        <path d="m16 3 4 4-4 4" />
        <path d="M20 7H4" />
        <path d="m8 21-4-4 4-4" />
        <path d="M4 17h16" />
      </svg>
    ),
    x: (
      <svg {...common}>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    ),
  }

  return icons[name] || null
}

function IconButton({ label, onClick, children, className = '', disabled = false }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  )
}

export default function App() {
  const { locale, changeLocale, t } = useI18n()
  const saved = useRef(loadSaved()).current
  const [appMode, setAppMode] = useState(APP_MODES.includes(saved.appMode) ? saved.appMode : 'standard')
  const [sourceText, setSourceText] = useState(saved.sourceText || '')
  const [translatedText, setTranslatedText] = useState(saved.translatedText || '')
  const [sourceLang, setSourceLang] = useState(saved.sourceLang || 'Auto-detect')
  const [targetLang, setTargetLang] = useState(saved.targetLang || 'Spanish')
  const [customSourceLang, setCustomSourceLang] = useState(saved.customSourceLang || '')
  const [customTargetLang, setCustomTargetLang] = useState(saved.customTargetLang || '')
  const [conversationUserName, setConversationUserName] = useState(saved.conversationUserName || '')
  const [conversationUserLang, setConversationUserLang] = useState(saved.conversationUserLang || 'English')
  const [conversationCustomUserLang, setConversationCustomUserLang] = useState(saved.conversationCustomUserLang || '')
  const [conversationOtherName, setConversationOtherName] = useState(saved.conversationOtherName || '')
  const [conversationOtherLang, setConversationOtherLang] = useState(saved.conversationOtherLang || 'Japanese')
  const [conversationCustomOtherLang, setConversationCustomOtherLang] = useState(saved.conversationCustomOtherLang || '')
  const [conversationMessages, setConversationMessages] = useState(() => normalizeConversationMessages(saved))
  const [conversationDraftSide, setConversationDraftSide] = useState(
    CONVERSATION_SIDES.includes(saved.conversationDraftSide) ? saved.conversationDraftSide : 'user'
  )
  const [conversationDraftText, setConversationDraftText] = useState('')
  const [expandedConversationMessageIds, setExpandedConversationMessageIds] = useState(() => new Set())
  const [lastConversationMessageId, setLastConversationMessageId] = useState(saved.lastConversationMessageId || '')
  const [conversationTranslatedText, setConversationTranslatedText] = useState(saved.conversationTranslatedText || '')
  const [tone, setTone] = useState(saved.tone || '')
  const [modelMode, setModelMode] = useState(normalizeModelMode(saved.modelMode))
  const [rateLimitStatuses, setRateLimitStatuses] = useState({})
  const [quotaClock, setQuotaClock] = useState(Date.now())
  const [creditCode, setCreditCode] = useState('')
  const [creditCodeLoading, setCreditCodeLoading] = useState(false)
  const [creditCodeStatus, setCreditCodeStatus] = useState(null)
  const [autoTranslateEnabled, setAutoTranslateEnabled] = useState(saved.autoTranslateEnabled !== false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedSource, setCopiedSource] = useState(false)
  const [copiedTarget, setCopiedTarget] = useState(false)
  const [copiedConversationOutput, setCopiedConversationOutput] = useState(false)
  const [debouncedAutoSubmitVersion, setDebouncedAutoSubmitVersion] = useState(0)
  const [instantAutoSubmitVersion, setInstantAutoSubmitVersion] = useState(0)
  const autoTranslateTimerRef = useRef(null)
  const latestTranslateRef = useRef(null)
  const lastSubmittedPayloadRef = useRef('')

  const sourceRef = useAutoResize(sourceText)
  const targetRef = useAutoResize(translatedText)
  const conversationDraftRef = useAutoResize(conversationDraftText)

  const clearPendingAutoTranslate = useCallback(() => {
    if (autoTranslateTimerRef.current) {
      clearTimeout(autoTranslateTimerRef.current)
      autoTranslateTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      appMode,
      sourceText,
      translatedText,
      sourceLang,
      targetLang,
      customSourceLang,
      customTargetLang,
      conversationUserName,
      conversationUserLang,
      conversationCustomUserLang,
      conversationOtherName,
      conversationOtherLang,
      conversationCustomOtherLang,
      conversationMessages,
      conversationDraftSide,
      lastConversationMessageId,
      conversationTranslatedText,
      tone,
      modelMode,
      autoTranslateEnabled,
    }))
  }, [
    appMode,
    sourceText,
    translatedText,
    sourceLang,
    targetLang,
    customSourceLang,
    customTargetLang,
    conversationUserName,
    conversationUserLang,
    conversationCustomUserLang,
    conversationOtherName,
    conversationOtherLang,
    conversationCustomOtherLang,
    conversationMessages,
    conversationDraftSide,
    lastConversationMessageId,
    conversationTranslatedText,
    tone,
    modelMode,
    autoTranslateEnabled,
  ])

  const resolvedSourceLang = sourceLang === CUSTOM ? customSourceLang.trim() : sourceLang
  const resolvedTargetLang = targetLang === CUSTOM ? customTargetLang.trim() : targetLang
  const resolvedConversationUserLang = conversationUserLang === CUSTOM
    ? conversationCustomUserLang.trim()
    : conversationUserLang
  const resolvedConversationOtherLang = conversationOtherLang === CUSTOM
    ? conversationCustomOtherLang.trim()
    : conversationOtherLang

  const submitTranslationPayload = useCallback(async (payload) => {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json()
    if (data.rateLimit) {
      setRateLimitStatuses((statuses) => ({
        ...statuses,
        [data.rateLimit.mode]: data.rateLimit,
      }))
    }
    if (!res.ok) {
      if (data.rejected) {
        const rejectionMessages = {
          safety: t.blockedTranslation,
          untranslatable: t.untranslatableTranslation,
        }

        throw new Error(rejectionMessages[data.rejectionType] || data.error || 'Translation failed')
      }

      if (data.limitExceeded && data.rateLimit?.resetAt) {
        throw new Error(
          (t.limitReachedWithReset || '{mode} limit reached. Try again in {timeLeft} at {resetTime}.')
            .replace('{mode}', data.rateLimit.label || getModelModeLabel(t, data.rateLimit.mode))
            .replace(
              '{timeLeft}',
              formatQuotaReset(t, data.rateLimit.resetAt, Date.now(), '{timeLeft}')
            )
            .replace(
              '{resetTime}',
              formatQuotaReset(t, data.rateLimit.resetAt, Date.now(), '{resetTime}')
            )
        )
      }

      throw new Error(data.error || 'Translation failed')
    }

    return data.translation
  }, [t])

  useEffect(() => {
    let canceled = false

    fetch('/api/rate-limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientIdentity: getClientIdentity() }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!canceled && data?.rateLimits) setRateLimitStatuses(data.rateLimits)
      })
      .catch(() => undefined)

    return () => {
      canceled = true
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setQuotaClock(Date.now()), 60000)
    return () => clearInterval(interval)
  }, [])

  const translate = useCallback(async ({ dedupe = false } = {}) => {
    if (!sourceText.trim()) return
    if (targetLang === CUSTOM && !customTargetLang.trim()) return

    const payload = {
      mode: 'standard',
      text: sourceText,
      sourceLanguage: resolvedSourceLang || 'Auto-detect',
      targetLanguage: resolvedTargetLang,
      tone: tone.trim() || undefined,
      modelMode,
      clientIdentity: getClientIdentity(),
    }
    const payloadKey = JSON.stringify(payload)

    if (dedupe && lastSubmittedPayloadRef.current === payloadKey) return
    lastSubmittedPayloadRef.current = payloadKey

    setLoading(true)
    setError('')
    setTranslatedText('')

    try {
      setTranslatedText(await submitTranslationPayload(payload))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sourceText, resolvedSourceLang, resolvedTargetLang, tone, modelMode, targetLang, customTargetLang, submitTranslationPayload])

  const translateConversation = useCallback(async () => {
    const activeMessage =
      conversationMessages.find((message) => message.id === lastConversationMessageId) ||
      conversationMessages[conversationMessages.length - 1]

    if (!activeMessage?.text.trim()) return
    if (!resolvedConversationUserLang || !resolvedConversationOtherLang) return

    clearPendingAutoTranslate()
    setLoading(true)
    setError('')
    setConversationTranslatedText('')

    try {
      const payload = {
        mode: 'conversation',
        userName: conversationUserName.trim() || undefined,
        userLanguage: resolvedConversationUserLang,
        otherName: conversationOtherName.trim() || undefined,
        otherLanguage: resolvedConversationOtherLang,
        conversationMessages,
        activeMessageId: activeMessage.id,
        tone: tone.trim() || undefined,
        modelMode,
        clientIdentity: getClientIdentity(),
      }

      setConversationTranslatedText(await submitTranslationPayload(payload))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [
    conversationMessages,
    lastConversationMessageId,
    resolvedConversationUserLang,
    resolvedConversationOtherLang,
    clearPendingAutoTranslate,
    conversationUserName,
    conversationOtherName,
    tone,
    modelMode,
    submitTranslationPayload,
  ])

  useEffect(() => {
    latestTranslateRef.current = translate
  }, [translate])

  const queueDebouncedAutoSubmit = () => {
    if (!autoTranslateEnabled) {
      clearPendingAutoTranslate()
      return
    }

    setDebouncedAutoSubmitVersion((version) => version + 1)
  }

  const queueInstantAutoSubmit = () => {
    if (!autoTranslateEnabled) {
      clearPendingAutoTranslate()
      return
    }

    setInstantAutoSubmitVersion((version) => version + 1)
  }

  useEffect(() => {
    if (debouncedAutoSubmitVersion === 0 || !autoTranslateEnabled) return undefined

    clearPendingAutoTranslate()
    autoTranslateTimerRef.current = setTimeout(() => {
      autoTranslateTimerRef.current = null
      latestTranslateRef.current?.({ dedupe: true })
    }, AUTO_TRANSLATE_DELAY)

    return clearPendingAutoTranslate
  }, [debouncedAutoSubmitVersion, autoTranslateEnabled, clearPendingAutoTranslate])

  useEffect(() => {
    if (instantAutoSubmitVersion === 0 || !autoTranslateEnabled) return

    clearPendingAutoTranslate()
    latestTranslateRef.current?.({ dedupe: true })
  }, [instantAutoSubmitVersion, autoTranslateEnabled, clearPendingAutoTranslate])

  useEffect(() => {
    if (!autoTranslateEnabled) clearPendingAutoTranslate()
  }, [autoTranslateEnabled, clearPendingAutoTranslate])

  useEffect(() => {
    if (!settingsOpen) return undefined

    const handleEscape = (e) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [settingsOpen])

  const handleSwap = () => {
    if (sourceLang === 'Auto-detect') return

    clearPendingAutoTranslate()

    const prevSourceLang = sourceLang
    const prevTargetLang = targetLang
    const prevCustomSource = customSourceLang
    const prevCustomTarget = customTargetLang

    setSourceLang(prevTargetLang)
    setTargetLang(prevSourceLang)
    setCustomSourceLang(prevCustomTarget)
    setCustomTargetLang(prevCustomSource)
    if (translatedText.trim()) {
      setSourceText(translatedText)
      setTranslatedText(sourceText)
    } else {
      setTranslatedText('')
    }
  }

  const handleSourceTextChange = (e) => {
    setSourceText(e.target.value)
    queueDebouncedAutoSubmit()
  }

  const handleToneChange = (e) => {
    setTone(e.target.value)
    queueDebouncedAutoSubmit()
  }

  const handleLanguageChange = (setValue) => (e) => {
    setValue(e.target.value)
    queueInstantAutoSubmit()
  }

  const handleCustomLanguageChange = (setCustomValue) => (e) => {
    setCustomValue(e.target.value)
    queueDebouncedAutoSubmit()
  }

  const handleModelModeChange = (nextMode) => {
    setModelMode(nextMode)
    if (appMode === 'standard') queueInstantAutoSubmit()
  }

  const handleAutoTranslateChange = (e) => {
    const nextEnabled = e.target.checked
    setAutoTranslateEnabled(nextEnabled)
    if (nextEnabled && appMode === 'standard') setInstantAutoSubmitVersion((version) => version + 1)
  }

  const handleCreditCodeRedeem = async (e) => {
    e.preventDefault()
    const code = creditCode.trim()
    if (!code || creditCodeLoading) return

    setCreditCodeLoading(true)
    setCreditCodeStatus(null)

    try {
      const res = await fetch('/api/credit-codes/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, clientIdentity: getClientIdentity() }),
      })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Credit code could not be redeemed.')
      if (data.rateLimits) setRateLimitStatuses(data.rateLimits)

      setCreditCode('')
      setCreditCodeStatus({
        type: 'success',
        text: data.message || t.creditCodeRedeemed || 'Credit code redeemed.',
      })
    } catch (err) {
      setCreditCodeStatus({
        type: 'error',
        text: err.message || t.creditCodeRedeemFailed || 'Credit code could not be redeemed.',
      })
    } finally {
      setCreditCodeLoading(false)
    }
  }

  const handleAppModeChange = (nextMode) => {
    clearPendingAutoTranslate()
    setAppMode(nextMode)
    setError('')
  }

  const handleAddConversationMessage = () => {
    const text = conversationDraftText.trim()
    if (!text) return

    const nextMessage = createConversationMessage(conversationDraftSide, text)
    setConversationMessages((messages) => [...messages, nextMessage])
    setLastConversationMessageId(nextMessage.id)
    setConversationDraftText('')
    setConversationTranslatedText('')
    setError('')
  }

  const handleConversationMessageChange = (id, text) => {
    setConversationMessages((messages) => messages.map((message) => (
      message.id === id ? { ...message, text } : message
    )))
    if (id === lastConversationMessageId) setConversationTranslatedText('')
    setError('')
  }

  const handleConversationSideChange = (id, side) => {
    setConversationMessages((messages) => messages.map((message) => (
      message.id === id ? { ...message, side } : message
    )))
    if (id === lastConversationMessageId) setConversationTranslatedText('')
    setError('')
  }

  const handleToggleConversationMessageExpanded = (id) => {
    setExpandedConversationMessageIds((expandedIds) => {
      const nextExpandedIds = new Set(expandedIds)
      if (nextExpandedIds.has(id)) {
        nextExpandedIds.delete(id)
      } else {
        nextExpandedIds.add(id)
      }
      return nextExpandedIds
    })
  }

  const handleRemoveConversationMessage = (id) => {
    setConversationMessages((messages) => {
      const nextMessages = messages.filter((message) => message.id !== id)
      if (id === lastConversationMessageId) {
        setLastConversationMessageId(nextMessages[nextMessages.length - 1]?.id || '')
        setConversationTranslatedText('')
      }
      return nextMessages
    })
    setExpandedConversationMessageIds((expandedIds) => {
      if (!expandedIds.has(id)) return expandedIds
      const nextExpandedIds = new Set(expandedIds)
      nextExpandedIds.delete(id)
      return nextExpandedIds
    })
    setError('')
  }

  const handleClearConversation = () => {
    setConversationMessages([])
    setExpandedConversationMessageIds(new Set())
    setLastConversationMessageId('')
    setConversationTranslatedText('')
    setError('')
  }

  const handleManualTranslate = () => {
    clearPendingAutoTranslate()
    if (appMode === 'conversation') {
      translateConversation()
      return
    }
    translate()
  }

  const copyToClipboard = async (text, setCopied) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleManualTranslate()
    }
  }

  const canSwap = sourceLang !== 'Auto-detect'
  const langMap = languageNames[locale] || languageNames.en
  const displayLang = (lang) =>
    lang === 'Auto-detect' ? t.autoDetect : lang === CUSTOM ? (t.custom || 'Custom') : (langMap[lang] || lang)
  const displaySelectedLang = (lang, customValue) =>
    lang === CUSTOM ? (customValue.trim() || displayLang(lang)) : displayLang(lang)
  const activeConversationMessage =
    conversationMessages.find((message) => message.id === lastConversationMessageId) ||
    conversationMessages[conversationMessages.length - 1] ||
    null
  const activeConversationTargetDisplay = activeConversationMessage?.side === 'other'
    ? displaySelectedLang(conversationUserLang, conversationCustomUserLang)
    : displaySelectedLang(conversationOtherLang, conversationCustomOtherLang)
  const activeConversationAuthor = activeConversationMessage?.side === 'other'
    ? (conversationOtherName.trim() || t.otherSide || 'Other person')
    : (conversationUserName.trim() || t.userSide || 'You')
  const getConversationSideLabel = (side) => (
    side === 'other'
      ? (conversationOtherName.trim() || t.otherSide || 'Other person')
      : (conversationUserName.trim() || t.userSide || 'You')
  )
  const getConversationSideLanguage = (side) => (
    side === 'other'
      ? displaySelectedLang(conversationOtherLang, conversationCustomOtherLang)
      : displaySelectedLang(conversationUserLang, conversationCustomUserLang)
  )

  const canTranslate = appMode === 'conversation'
    ? Boolean(!loading && activeConversationMessage?.text.trim() && resolvedConversationUserLang && resolvedConversationOtherLang)
    : Boolean(!loading && sourceText.trim() && (targetLang !== CUSTOM || customTargetLang.trim()))
  const shortcutLabel =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '')
      ? '⌘+⏎'
      : 'Ctrl+⏎'
  const shortcutHint = (t.shortcutHint || 'Press {shortcut} to translate').replace('{shortcut}', shortcutLabel)
  const getModeUsage = (mode) => {
    const details = MODEL_MODE_DETAILS[mode]
    const status = rateLimitStatuses[mode]

    return {
      remaining: typeof status?.remaining === 'number' ? status.remaining : details.limit,
      limit: typeof status?.limit === 'number' ? status.limit : details.limit,
      resetAt: status?.resetAt || '',
    }
  }

  const languagePicker = (kind) => {
    const isSource = kind === 'source'
    const id = isSource ? 'source-language' : 'target-language'
    const label = isSource ? t.source : t.translation
    const value = isSource ? sourceLang : targetLang
    const options = isSource ? LANGUAGES : TARGET_LANGUAGES
    const setValue = isSource ? setSourceLang : setTargetLang
    const customValue = isSource ? customSourceLang : customTargetLang
    const setCustomValue = isSource ? setCustomSourceLang : setCustomTargetLang

    return (
      <div className="language-picker">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={value}
          onChange={handleLanguageChange(setValue)}
          className="language-select"
        >
          {options.map((lang) => (
            <option key={lang} value={lang}>
              {displayLang(lang)}
            </option>
          ))}
        </select>
        {value === CUSTOM && (
          <input
            type="text"
            className="custom-language"
            placeholder={t.customLangPlaceholder || 'Type a language...'}
            value={customValue}
            onChange={handleCustomLanguageChange(setCustomValue)}
            onKeyDown={handleKeyDown}
            aria-label={isSource ? (t.customSourceLanguage || 'Custom source language') : (t.customTargetLanguage || 'Custom target language')}
          />
        )}
      </div>
    )
  }

  const conversationLanguagePicker = ({
    id,
    value,
    setValue,
    customValue,
    setCustomValue,
    label,
  }) => (
    <div className="language-picker">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError('')
        }}
        className="language-select"
      >
        {TARGET_LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>
            {displayLang(lang)}
          </option>
        ))}
      </select>
      {value === CUSTOM && (
        <input
          type="text"
          className="custom-language"
          placeholder={t.customLangPlaceholder || 'Type a language...'}
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={label}
        />
      )}
    </div>
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-heading">
            <h1>Translerator</h1>
            <span className="app-version">v{APP_VERSION}</span>
          </div>
          <p>{t.subtitle}</p>
        </div>

        <div className="topbar-controls">
          <IconButton
            className="settings-button"
            label={t.settings || 'Settings'}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={18} />
          </IconButton>
        </div>
      </header>

      {settingsOpen && (
        <div
          className="settings-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false)
          }}
        >
          <aside
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-header">
              <div>
                <h2 id="settings-title">{t.settings || 'Settings'}</h2>
                <p>{t.settingsDescription || 'Translation and interface preferences'}</p>
              </div>
              <IconButton label={t.closeSettings || 'Close settings'} onClick={() => setSettingsOpen(false)}>
                <Icon name="x" size={18} />
              </IconButton>
            </div>

            <div className="settings-content">
              <section className="setting-group">
                <div className="setting-heading">
                  <h3>{t.translationSettings || 'Translation'}</h3>
                  <p>{t.translationSettingsDescription || 'Control when translations run and which model they use.'}</p>
                </div>

                <label className="toggle-row">
                  <span>
                    <strong>{t.autoTranslateLabel || 'Auto-translate after edits'}</strong>
                    <small>{t.autoTranslateDescription || 'Translate automatically after text, tone, or language changes.'}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={autoTranslateEnabled}
                    onChange={handleAutoTranslateChange}
                  />
                  <span className="toggle-control" aria-hidden="true" />
                </label>

                <div className="setting-field">
                  <div className="setting-label">
                    <span>{t.modelModeLabel || 'Model mode'}</span>
                    <small>{t.modelModeDescription || 'Fast uses Haiku, Precise uses Sonnet, and Super uses Opus.'}</small>
                  </div>
                  <div className="model-mode-details" role="radiogroup" aria-label={t.modelModeDetails || 'Model mode details'}>
                    {MODEL_MODES.map((mode) => {
                      const details = MODEL_MODE_DETAILS[mode]
                      const usage = getModeUsage(mode)
                      const usageSuffix = usage.remaining > usage.limit
                        ? (t.modelBonusUsageSuffix || 'left with credit bonus')
                        : (t.modelUsageSuffix || 'of {limit} left in 24h').replace('{limit}', usage.limit)

                      return (
                        <button
                          key={mode}
                          type="button"
                          className={modelMode === mode ? 'is-active' : ''}
                          onClick={() => handleModelModeChange(mode)}
                          role="radio"
                          aria-checked={modelMode === mode}
                        >
                          <span className="model-card-header">
                            <strong>{getModelModeLabel(t, mode)}</strong>
                            <span>{details.model}</span>
                          </span>
                          <span className="model-card-usage">
                            <strong>{usage.remaining}</strong>
                            <span>{usageSuffix}</span>
                          </span>
                          <span className="model-card-reset">{formatQuotaReset(t, usage.resetAt, quotaClock)}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <form className="setting-field credit-code-form" onSubmit={handleCreditCodeRedeem}>
                  <div className="setting-label">
                    <span>{t.creditCodeLabel || 'Credit code'}</span>
                    <small>{t.creditCodeDescription || 'Redeem credits for any model mode included in the code.'}</small>
                  </div>
                  <div className="credit-code-controls">
                    <input
                      type="text"
                      value={creditCode}
                      onChange={(e) => {
                        setCreditCode(e.target.value)
                        setCreditCodeStatus(null)
                      }}
                      placeholder={t.creditCodePlaceholder || 'Enter code'}
                      autoCapitalize="characters"
                      spellCheck={false}
                      aria-label={t.creditCodeLabel || 'Credit code'}
                    />
                    <button
                      type="submit"
                      disabled={creditCodeLoading || !creditCode.trim()}
                    >
                      <Icon name="ticket" size={16} />
                      <span>{creditCodeLoading ? (t.redeemingCreditCode || 'Redeeming...') : (t.redeemCreditCode || 'Redeem')}</span>
                    </button>
                  </div>
                  {creditCodeStatus && (
                    <p className={`credit-code-status is-${creditCodeStatus.type}`} role={creditCodeStatus.type === 'error' ? 'alert' : 'status'}>
                      {creditCodeStatus.text}
                    </p>
                  )}
                </form>
              </section>

              <section className="setting-group">
                <div className="setting-heading">
                  <h3>{t.interfaceSettings || 'Interface'}</h3>
                  <p>{t.interfaceSettingsDescription || 'Choose the language for app controls.'}</p>
                </div>

                <div className="setting-field">
                  <div className="setting-label">
                    <span>{t.interfaceLanguage || 'Interface language'}</span>
                  </div>
                  <div className="locale-switcher settings-locale-switcher">
                    <Icon name="globe" size={16} />
                    <select
                      value={locale}
                      onChange={(e) => changeLocale(e.target.value)}
                      className="locale-select"
                      aria-label={t.interfaceLanguage || 'Interface language'}
                    >
                      {UI_LOCALES.map(({ code, label }) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}

      <main className="workspace">
        <section className="app-mode-bar" aria-label={t.translationMode || 'Translation mode'}>
          <div className="mode-switcher app-mode-switcher" role="tablist" aria-label={t.translationMode || 'Translation mode'}>
            {APP_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={appMode === mode ? 'is-active' : ''}
                onClick={() => handleAppModeChange(mode)}
                role="tab"
                aria-selected={appMode === mode}
              >
                {mode === 'standard'
                  ? (t.standardMode || 'Standard')
                  : (t.conversationMode || 'Conversation')}
              </button>
            ))}
          </div>
        </section>

        {appMode === 'standard' ? (
          <>
        <section className="language-bar" aria-label={t.languageControls || 'Language controls'}>
          {languagePicker('source')}

          <IconButton
            className="swap-button"
            label={!canSwap ? t.swapDisabled : t.swap}
            onClick={handleSwap}
            disabled={!canSwap}
          >
            <Icon name="swap" size={18} />
          </IconButton>

          {languagePicker('target')}
        </section>

        <section className="tone-panel">
          <label htmlFor="tone">{t.toneLabel}</label>
          <input
            id="tone"
            type="text"
            className="tone-input"
            placeholder={t.tonePlaceholder}
            value={tone}
            onChange={handleToneChange}
            onKeyDown={handleKeyDown}
          />
        </section>

        <section className="editor-grid">
          <article className="editor-pane">
            <div className="pane-toolbar">
              <div>
                <h2>{t.source}</h2>
                <p>{displaySelectedLang(sourceLang, customSourceLang)}</p>
              </div>
              <div className="pane-actions">
                <span>{sourceText.length}</span>
                {sourceText && (
                  <>
                    <IconButton
                      label={t.copySource}
                      onClick={() => copyToClipboard(sourceText, setCopiedSource)}
                    >
                      <Icon name={copiedSource ? 'check' : 'copy'} size={16} />
                    </IconButton>
                    <IconButton
                      className="danger-button"
                      label={t.clear}
                      onClick={() => {
                        clearPendingAutoTranslate()
                        setSourceText('')
                        setTranslatedText('')
                        setError('')
                      }}
                    >
                      <Icon name="clear" size={16} />
                    </IconButton>
                  </>
                )}
              </div>
            </div>

            <textarea
              ref={sourceRef}
              className="text-area auto-grow"
              placeholder={t.inputPlaceholder}
              value={sourceText}
              onChange={handleSourceTextChange}
              onKeyDown={handleKeyDown}
              aria-label={t.sourceText || 'Source text'}
            />
          </article>

          <article className="editor-pane output-pane">
            <div className="pane-toolbar">
              <div>
                <h2>{t.translation}</h2>
                <p>{displaySelectedLang(targetLang, customTargetLang)}</p>
              </div>
              <div className="pane-actions">
                <span>{translatedText.length}</span>
                {translatedText && (
                  <IconButton
                    label={t.copyTranslation}
                    onClick={() => copyToClipboard(translatedText, setCopiedTarget)}
                  >
                    <Icon name={copiedTarget ? 'check' : 'copy'} size={16} />
                  </IconButton>
                )}
              </div>
            </div>

            {loading ? (
              <div className="text-area output-area loading-state" role="status" aria-live="polite">
                <span className="loader" aria-hidden="true" />
                <span>{t.translating}</span>
              </div>
            ) : error ? (
              <div className="text-area output-area" role="alert">
                <p className="error-text">{error}</p>
              </div>
            ) : (
              <textarea
                ref={targetRef}
                className="text-area auto-grow"
                placeholder={t.outputPlaceholder}
                value={translatedText}
                onChange={(e) => setTranslatedText(e.target.value)}
                aria-label={t.translationText || 'Translation text'}
              />
            )}
          </article>
        </section>

        <div className="action-bar">
          <p className="shortcut-hint">{shortcutHint}</p>
          <button
            type="button"
            className="translate-button"
            onClick={handleManualTranslate}
            disabled={!canTranslate}
          >
            <Icon name="send" size={18} />
            <span>{loading ? t.translating : t.translate}</span>
          </button>
        </div>
          </>
        ) : (
          <>
            <section className="conversation-participants">
              <article className="participant-panel">
                <label htmlFor="conversation-user-name">{t.youName || 'Your name'}</label>
                <input
                  id="conversation-user-name"
                  type="text"
                  className="participant-input"
                  placeholder={t.youNamePlaceholder || 'e.g. John Doe'}
                  value={conversationUserName}
                  onChange={(e) => setConversationUserName(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                {conversationLanguagePicker({
                  id: 'conversation-user-language',
                  value: conversationUserLang,
                  setValue: setConversationUserLang,
                  customValue: conversationCustomUserLang,
                  setCustomValue: setConversationCustomUserLang,
                  label: t.yourLanguage || 'Your language',
                })}
              </article>

              <article className="participant-panel">
                <label htmlFor="conversation-other-name">{t.otherName || 'Their name'}</label>
                <input
                  id="conversation-other-name"
                  type="text"
                  className="participant-input"
                  placeholder={t.otherNamePlaceholder || 'e.g. Jane Doe'}
                  value={conversationOtherName}
                  onChange={(e) => setConversationOtherName(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                {conversationLanguagePicker({
                  id: 'conversation-other-language',
                  value: conversationOtherLang,
                  setValue: setConversationOtherLang,
                  customValue: conversationCustomOtherLang,
                  setCustomValue: setConversationCustomOtherLang,
                  label: t.theirLanguage || 'Their language',
                })}
              </article>
            </section>

            <section className="editor-grid conversation-grid">
              <article className="editor-pane conversation-pane">
                <div className="pane-toolbar">
                  <div>
                    <h2>{t.conversationTranscript || 'Conversation'}</h2>
                    <p>{activeConversationMessage
                      ? `${activeConversationAuthor} -> ${activeConversationTargetDisplay}`
                      : (t.noConversationMessages || 'Add messages from either side')}
                    </p>
                  </div>
                  <div className="pane-actions">
                    <span>{conversationMessages.length}</span>
                    {conversationMessages.length > 0 && (
                      <IconButton
                        className="danger-button"
                        label={t.clear}
                        onClick={handleClearConversation}
                      >
                        <Icon name="clear" size={16} />
                      </IconButton>
                    )}
                  </div>
                </div>

                <div className="conversation-workspace">
                  <div className="chat-thread" aria-label={t.conversationTranscript || 'Conversation'}>
                    {conversationMessages.length === 0 ? (
                      <div className="empty-thread">
                        <p>{t.emptyConversation || 'No messages yet.'}</p>
                      </div>
                    ) : (
                      conversationMessages.map((message) => {
                        const isActive = activeConversationMessage?.id === message.id
                        const isLongMessage = isVeryLongConversationMessage(message.text)
                        const isExpanded = expandedConversationMessageIds.has(message.id)
                        const isCollapsed = isLongMessage && !isExpanded

                        return (
                          <article
                            key={message.id}
                            className={`chat-message ${message.side === 'user' ? 'is-user' : 'is-other'} ${isActive ? 'is-active' : ''}`}
                          >
                            <div className="message-meta">
                              <span
                                className="message-author"
                                data-active={isActive ? 'true' : 'false'}
                              >
                                {getConversationSideLabel(message.side)}
                              </span>
                              <select
                                value={message.side}
                                onChange={(e) => handleConversationSideChange(message.id, e.target.value)}
                                className="message-side-select"
                                aria-label={t.messageSide || 'Message side'}
                              >
                                <option value="user">{t.userSide || 'You'}</option>
                                <option value="other">{t.otherSide || 'Other person'}</option>
                              </select>
                              <span>{getConversationSideLanguage(message.side)}</span>
                              <IconButton
                                className="danger-button"
                                label={t.clear}
                                onClick={() => handleRemoveConversationMessage(message.id)}
                              >
                                <Icon name="clear" size={15} />
                              </IconButton>
                            </div>
                            <textarea
                              ref={(el) => resizeMessageTextarea(el, isCollapsed)}
                              className={`message-text ${isCollapsed ? 'is-collapsed' : ''}`}
                              value={message.text}
                              onChange={(e) => handleConversationMessageChange(message.id, e.target.value)}
                              onKeyDown={handleKeyDown}
                              aria-label={`${getConversationSideLabel(message.side)} ${t.messageText || 'message text'}`}
                            />
                            {isLongMessage && (
                              <button
                                type="button"
                                className="message-expand-button"
                                onClick={() => handleToggleConversationMessageExpanded(message.id)}
                                aria-expanded={isExpanded}
                              >
                                {isExpanded ? (t.showLessMessage || 'Show less') : (t.showAllMessage || 'Show all')}
                              </button>
                            )}
                          </article>
                        )
                      })
                    )}
                  </div>

                  <div className="chat-composer">
                    <div className="composer-side-switcher" role="radiogroup" aria-label={t.messageSide || 'Message side'}>
                      {CONVERSATION_SIDES.map((side) => (
                        <button
                          key={side}
                          type="button"
                          className={conversationDraftSide === side ? 'is-active' : ''}
                          onClick={() => setConversationDraftSide(side)}
                          role="radio"
                          aria-checked={conversationDraftSide === side}
                        >
                          {side === 'user' ? (t.userSide || 'You') : (t.otherSide || 'Other person')}
                        </button>
                      ))}
                    </div>
                    <textarea
                      ref={conversationDraftRef}
                      className="text-area auto-grow composer-text"
                      placeholder={t.addConversationMessagePlaceholder || 'Insert a message from the chat...'}
                      value={conversationDraftText}
                      onChange={(e) => setConversationDraftText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      aria-label={t.addConversationMessage || 'Add conversation message'}
                    />
                    <button
                      type="button"
                      className="add-message-button"
                      onClick={handleAddConversationMessage}
                      disabled={!conversationDraftText.trim()}
                    >
                      <Icon name="send" size={16} />
                      <span>{t.addMessage || 'Add message'}</span>
                    </button>
                  </div>
                </div>
              </article>

              <article className="editor-pane output-pane conversation-output-pane">
                <div className="pane-toolbar">
                  <div>
                    <h2>{t.translatedMessage || 'Translated message'}</h2>
                    <p>{activeConversationMessage
                      ? activeConversationTargetDisplay
                      : (t.pickMessageToTranslate || 'Last inserted message')}
                    </p>
                  </div>
                  <div className="pane-actions">
                    <span>{conversationTranslatedText.length}</span>
                    {conversationTranslatedText && (
                      <IconButton
                        label={t.copyTranslation}
                        onClick={() => copyToClipboard(conversationTranslatedText, setCopiedConversationOutput)}
                      >
                        <Icon name={copiedConversationOutput ? 'check' : 'copy'} size={16} />
                      </IconButton>
                    )}
                  </div>
                </div>

                {loading ? (
                  <div className="text-area output-area loading-state" role="status" aria-live="polite">
                    <span className="loader" aria-hidden="true" />
                    <span>{t.translating}</span>
                  </div>
                ) : error ? (
                  <div className="text-area output-area" role="alert">
                    <p className="error-text">{error}</p>
                  </div>
                ) : (
                  <textarea
                    className="text-area conversation-output-text"
                    placeholder={t.translatedMessagePlaceholder || 'The translated message will appear here...'}
                    value={conversationTranslatedText}
                    onChange={(e) => setConversationTranslatedText(e.target.value)}
                    aria-label={t.translatedMessage || 'Translated message'}
                  />
                )}
              </article>
            </section>

            <div className="action-bar">
              <p className="shortcut-hint">{shortcutHint}</p>
              <button
                type="button"
                className="translate-button"
                onClick={handleManualTranslate}
                disabled={!canTranslate}
              >
                <Icon name="send" size={18} />
                <span>{loading ? t.translating : (t.translateMessage || 'Translate message')}</span>
              </button>
            </div>
          </>
        )}
      </main>

      <footer className="footer">
        {t.madeWith} <a href="https://mysty.lol" target="_blank" rel="noopener noreferrer">mysty</a> {t.withAI}
      </footer>
    </div>
  )
}
