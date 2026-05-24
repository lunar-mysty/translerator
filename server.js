import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
// import { OpenRouter } from '@openrouter/sdk'

const app = express()
const PORT = process.env.PORT || 8080
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL_CONFIGS = {
  fast: {
    label: 'Fast',
    displayModel: 'Claude Haiku 4.5',
    model: 'anthropic/claude-haiku-4.5:nitro',
    limit: 100,
  },
  precise: {
    label: 'Precise',
    displayModel: 'Claude Sonnet 4.6',
    model: 'anthropic/claude-sonnet-4.6:nitro',
    limit: 50,
  },
  super: {
    label: 'Super',
    displayModel: 'Claude Opus 4.7',
    model: 'anthropic/claude-opus-4.7',
    limit: 25,
  },
}
const MODEL_MODE_ALIASES = {
  accurate: 'precise',
}
const OPENROUTER_MODELS = Object.fromEntries(
  Object.entries(MODEL_CONFIGS).map(([mode, config]) => [mode, config.model])
)
const DEFAULT_MODEL_MODE = 'fast'
const REQUEST_TIMEOUT_MS = 30000
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000
const RATE_LIMIT_COOKIE_NAME = 'translerator_client_id'
const RATE_LIMIT_STORE_PATH = process.env.TRANSLERATOR_RATE_LIMIT_STORE_PATH
  ? resolve(__dirname, process.env.TRANSLERATOR_RATE_LIMIT_STORE_PATH)
  : join(__dirname, 'data', 'request-limits.json')
const RATE_LIMIT_HASH_SALT = process.env.TRANSLERATOR_RATE_LIMIT_HASH_SALT || 'translerator-rate-limit'
const CREDIT_CODE_FILE_PATH = process.env.TRANSLERATOR_CREDIT_CODE_FILE_PATH
  ? resolve(__dirname, process.env.TRANSLERATOR_CREDIT_CODE_FILE_PATH)
  : ''
const MAX_TEXT_LENGTH = 12000
const MAX_FIELD_LENGTH = 1024
const MAX_CONVERSATION_MESSAGES = 80
const BLOCKED_TRANSLATION_ERROR =
  'This text was not translated because it appears to request serious harm, illegal activity, or hate.'
const UNTRANSLATABLE_ERROR =
  'This text was not translated because it is not meaningfully translatable or the request is unclear.'

class ProviderResponseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProviderResponseError'
    this.status = 502
    this.publicMessage = message
  }
}

app.use(cors())
app.use(express.json({ limit: '64kb' }))
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body.' })
  }

  next(err)
})

function parseModelResponse(content) {
  const trimmed = String(content || '').trim()

  const parseJson = (jsonText) => {
    try {
      return JSON.parse(jsonText)
    } catch {
      return JSON.parse(escapeJsonStringControlChars(jsonText))
    }
  }

  try {
    return parseJson(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return parseJson(trimmed.slice(start, end + 1))
      } catch {
        throw new ProviderResponseError('Translation provider returned malformed JSON content.')
      }
    }
    throw new ProviderResponseError('Translation provider returned non-JSON content.')
  }
}

function escapeJsonStringControlChars(jsonText) {
  let escaped = ''
  let inString = false
  let isEscaped = false

  for (const char of jsonText) {
    if (!inString) {
      escaped += char
      if (char === '"') inString = true
      continue
    }

    if (isEscaped) {
      escaped += char
      isEscaped = false
      continue
    }

    if (char === '\\') {
      escaped += char
      isEscaped = true
      continue
    }

    if (char === '"') {
      escaped += char
      inString = false
      continue
    }

    if (char === '\n') {
      escaped += '\\n'
      continue
    }

    if (char === '\r') {
      escaped += '\\r'
      continue
    }

    if (char === '\t') {
      escaped += '\\t'
      continue
    }

    if (char < ' ') {
      escaped += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
      continue
    }

    escaped += char
  }

  return escaped
}

function getProviderMessage(data) {
  return data.choices?.[0]?.message?.content
}

function cleanField(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeModelMode(value) {
  const mode = cleanField(value) || DEFAULT_MODEL_MODE
  return MODEL_MODE_ALIASES[mode] || mode
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separator = cookie.indexOf('=')
        if (separator === -1) return [cookie, '']
        const name = cookie.slice(0, separator)
        const value = cookie.slice(separator + 1)
        try {
          return [decodeURIComponent(name), decodeURIComponent(value)]
        } catch {
          return [name, value]
        }
      })
  )
}

function hashSignal(value) {
  return crypto
    .createHash('sha256')
    .update(RATE_LIMIT_HASH_SALT)
    .update(':')
    .update(String(value))
    .digest('hex')
}

function addIdentitySignal(signals, type, value) {
  const cleaned = typeof value === 'string' ? value.trim() : value
  if (!cleaned) return
  const serialized = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned)
  if (!serialized || serialized === '{}' || serialized === '[]') return
  signals.set(`${type}:${hashSignal(serialized)}`, {
    type,
    valueHash: hashSignal(serialized),
  })
}

function getClientIps(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean)

  return [
    ...forwardedFor,
    req.headers['x-real-ip'],
    req.ip,
    req.socket?.remoteAddress,
  ].filter(Boolean)
}

function getRateLimitSignals(req) {
  const signals = new Map()
  const cookies = parseCookies(req.headers.cookie || '')
  const identity = req.body?.clientIdentity && typeof req.body.clientIdentity === 'object'
    ? req.body.clientIdentity
    : {}

  getClientIps(req).forEach((ip) => addIdentitySignal(signals, 'ip', ip))
  addIdentitySignal(signals, 'cookie', cookies[RATE_LIMIT_COOKIE_NAME])
  addIdentitySignal(signals, 'client-id', req.headers['x-translerator-client-id'])
  addIdentitySignal(signals, 'client-id', identity.clientId)
  addIdentitySignal(signals, 'hardware-id', req.headers['x-translerator-hardware-id'])
  addIdentitySignal(signals, 'hardware-id', identity.hardwareId)

  addIdentitySignal(signals, 'browser-fingerprint', {
    userAgent: req.headers['user-agent'],
    acceptLanguage: req.headers['accept-language'],
    platform: identity.platform,
    vendor: identity.vendor,
    language: identity.language,
    languages: identity.languages,
    timezone: identity.timezone,
    hardwareConcurrency: identity.hardwareConcurrency,
    deviceMemory: identity.deviceMemory,
    maxTouchPoints: identity.maxTouchPoints,
    screen: identity.screen,
    cookieEnabled: identity.cookieEnabled,
    doNotTrack: identity.doNotTrack,
  })

  return [...signals.values()]
}

async function readRateLimitStore() {
  try {
    const raw = await readFile(RATE_LIMIT_STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid rate limit store')
    return normalizeRateLimitStore({
      version: 1,
      identities: {},
      creditCodeRedemptions: {},
      ...parsed,
      identities: parsed.identities && typeof parsed.identities === 'object'
        ? parsed.identities
        : {},
      creditCodeRedemptions: parsed.creditCodeRedemptions && typeof parsed.creditCodeRedemptions === 'object'
        ? parsed.creditCodeRedemptions
        : {},
    })
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, identities: {}, creditCodeRedemptions: {} }
    console.warn('Rate limit store could not be read; starting with an empty store.', err)
    return { version: 1, identities: {}, creditCodeRedemptions: {} }
  }
}

function normalizeRateLimitStore(store) {
  for (const identity of Object.values(store.identities)) {
    if (!identity || typeof identity !== 'object') continue

    identity.buckets = identity.buckets && typeof identity.buckets === 'object'
      ? identity.buckets
      : {}
    identity.creditBalances = identity.creditBalances && typeof identity.creditBalances === 'object'
      ? identity.creditBalances
      : {}

    for (const [mode, bucket] of Object.entries(identity.buckets)) {
      if (!MODEL_CONFIGS[mode] || !bucket || typeof bucket !== 'object') continue

      const count = Number(bucket.count || 0)
      if (count >= 0) continue

      identity.creditBalances[mode] = getCreditBalance(identity, mode) + Math.abs(count)
      bucket.count = 0
    }
  }

  return store
}

async function writeRateLimitStore(store) {
  store.updatedAt = new Date().toISOString()
  await mkdir(dirname(RATE_LIMIT_STORE_PATH), { recursive: true })
  const tempPath = `${RATE_LIMIT_STORE_PATH}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`)
  await rename(tempPath, RATE_LIMIT_STORE_PATH)
}

function getFreshBucket(identity, mode, now) {
  identity.buckets ||= {}
  const bucket = identity.buckets[mode]
  if (!bucket || now - Number(bucket.windowStart || 0) >= RATE_LIMIT_WINDOW_MS) {
    identity.buckets[mode] = { windowStart: now, count: 0 }
  }

  return identity.buckets[mode]
}

let rateLimitStoreQueue = Promise.resolve()

function updateRateLimitStore(task) {
  const run = rateLimitStoreQueue
    .catch(() => undefined)
    .then(async () => {
      const store = await readRateLimitStore()
      const result = await task(store)
      await writeRateLimitStore(store)
      return result
    })

  rateLimitStoreQueue = run.then(() => undefined, () => undefined)
  return run
}

function getRemainingCredits(limit, count) {
  return limit - count
}

function getCreditBalance(identity, mode) {
  const balance = Number(identity?.creditBalances?.[mode] || 0)
  return Number.isFinite(balance) && balance > 0 ? balance : 0
}

function addCreditBalance(identity, mode, amount) {
  identity.creditBalances ||= {}
  identity.creditBalances[mode] = getCreditBalance(identity, mode) + amount
}

function consumeCreditBalances(store, signals, mode, amount, now = Date.now()) {
  let consumed = 0

  for (const signal of signals) {
    const identity = store.identities[`${signal.type}:${signal.valueHash}`]
    const balance = getCreditBalance(identity, mode)
    if (balance <= 0) continue

    identity.lastSeenAt = new Date(now).toISOString()
    identity.creditBalances[mode] = Math.max(0, balance - amount)
    consumed = Math.max(consumed, Math.min(balance, amount))
  }

  return consumed
}

function getHighestCreditBalanceFromSignals(store, signals, mode) {
  return signals.reduce((highest, signal) => {
    const identity = store.identities[`${signal.type}:${signal.valueHash}`]
    return Math.max(highest, getCreditBalance(identity, mode))
  }, 0)
}

function getHighestCountFromSignals(store, signals, mode, now) {
  let highestCount = null
  let resetAt = null

  for (const signal of signals) {
    const identity = store.identities[`${signal.type}:${signal.valueHash}`]
    const bucket = identity?.buckets?.[mode]
    if (!bucket || now - Number(bucket.windowStart || 0) >= RATE_LIMIT_WINDOW_MS) continue

    const count = Number(bucket.count || 0)
    highestCount = highestCount === null ? count : Math.max(highestCount, count)
    const bucketResetAt = Number(bucket.windowStart || now) + RATE_LIMIT_WINDOW_MS
    resetAt = resetAt === null ? bucketResetAt : Math.min(resetAt, bucketResetAt)
  }

  return {
    highestCount: highestCount === null ? 0 : highestCount,
    resetAt,
  }
}

function buildRateLimitUsage(mode, highestCount, resetAt, creditBalance = 0) {
  const config = MODEL_CONFIGS[mode]

  return {
    mode,
    label: config.label,
    model: config.displayModel,
    limit: config.limit,
    creditBalance,
    remaining: getRemainingCredits(config.limit, highestCount) + creditBalance,
    resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
    windowHours: 24,
  }
}

function getRateLimitSnapshotFromStore(store, signals, now) {
  return Object.fromEntries(
    Object.entries(MODEL_CONFIGS).map(([mode]) => {
      const { highestCount, resetAt } = getHighestCountFromSignals(store, signals, mode, now)
      const creditBalance = getHighestCreditBalanceFromSignals(store, signals, mode)
      return [mode, buildRateLimitUsage(mode, highestCount, resetAt, creditBalance)]
    })
  )
}

async function recordRateLimit(req, mode) {
  const config = MODEL_CONFIGS[mode]
  const signals = getRateLimitSignals(req)
  const now = Date.now()

  return updateRateLimitStore((store) => {
    const currentUsage = getHighestCountFromSignals(store, signals, mode, now)
    const currentCreditBalance = getHighestCreditBalanceFromSignals(store, signals, mode)
    let highestCount = currentUsage.highestCount
    let resetAt = currentUsage.resetAt
    let blockingType = ''

    if (highestCount >= config.limit && currentCreditBalance <= 0) {
      blockingType = signals.find((signal) => {
        const identity = store.identities[`${signal.type}:${signal.valueHash}`]
        const bucket = identity?.buckets?.[mode]
        return bucket && Number(bucket.count || 0) >= config.limit
      })?.type || 'usage'
    }

    if (blockingType) {
      return {
        allowed: false,
        usage: buildRateLimitUsage(mode, highestCount, resetAt, currentCreditBalance),
        blockingType,
      }
    }

    let chargeType = 'bucket'

    if (currentCreditBalance > 0) {
      consumeCreditBalances(store, signals, mode, 1, now)
      chargeType = 'credit'
    } else {
      for (const signal of signals) {
        const key = `${signal.type}:${signal.valueHash}`
        const identity = store.identities[key] || {
          type: signal.type,
          valueHash: signal.valueHash,
          firstSeenAt: new Date(now).toISOString(),
          buckets: {},
        }
        identity.lastSeenAt = new Date(now).toISOString()
        const bucket = getFreshBucket(identity, mode, now)
        bucket.count = Number(bucket.count || 0) + 1
        store.identities[key] = identity
      }

      const nextUsage = getHighestCountFromSignals(store, signals, mode, now)
      highestCount = nextUsage.highestCount
      resetAt = nextUsage.resetAt
    }

    const creditBalance = getHighestCreditBalanceFromSignals(store, signals, mode)

    return {
      allowed: true,
      chargeType,
      usage: buildRateLimitUsage(mode, highestCount, resetAt, creditBalance),
    }
  })
}

async function refundRateLimit(req, mode, chargeType = 'bucket') {
  const signals = getRateLimitSignals(req)
  const now = Date.now()

  return updateRateLimitStore((store) => {
    if (chargeType === 'credit') {
      for (const signal of signals) {
        const key = `${signal.type}:${signal.valueHash}`
        const identity = store.identities[key]
        if (!identity) continue

        addCreditBalance(identity, mode, 1)
        identity.lastSeenAt = new Date(now).toISOString()
      }

      return getRateLimitSnapshotFromStore(store, signals, now)[mode]
    }

    for (const signal of signals) {
      const key = `${signal.type}:${signal.valueHash}`
      const identity = store.identities[key]
      const bucket = identity?.buckets?.[mode]
      if (!bucket || now - Number(bucket.windowStart || 0) >= RATE_LIMIT_WINDOW_MS) continue

      bucket.count = Math.max(0, Number(bucket.count || 0) - 1)
      identity.lastSeenAt = new Date(now).toISOString()
    }

    return getRateLimitSnapshotFromStore(store, signals, now)[mode] || buildRateLimitUsage(mode, 0, null, 0)
  })
}

async function getRateLimitSnapshot(req) {
  const signals = getRateLimitSignals(req)
  const store = await readRateLimitStore()
  const now = Date.now()

  return getRateLimitSnapshotFromStore(store, signals, now)
}

function normalizeCreditCode(code) {
  return cleanField(code).toUpperCase()
}

async function readCreditCodeFile() {
  if (!CREDIT_CODE_FILE_PATH) {
    const err = new Error('Credit codes are not configured.')
    err.status = 503
    throw err
  }

  try {
    const raw = await readFile(CREDIT_CODE_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid credit code file')
    const codes = parsed.codes && typeof parsed.codes === 'object' ? parsed.codes : parsed

    return Object.fromEntries(
      Object.entries(codes)
        .map(([code, definition]) => [normalizeCreditCode(code), definition])
        .filter(([code]) => Boolean(code))
    )
  } catch (err) {
    if (err.code === 'ENOENT') {
      const missingErr = new Error('Credit codes are not configured.')
      missingErr.status = 503
      throw missingErr
    }

    console.warn('Credit code file could not be read.', err)
    const invalidErr = new Error('Credit codes are not available.')
    invalidErr.status = 500
    throw invalidErr
  }
}

function normalizeCreditCodeCredits(rawCredits = {}) {
  const credits = {}

  if (!rawCredits || typeof rawCredits !== 'object' || Array.isArray(rawCredits)) return credits

  for (const [rawMode, rawAmount] of Object.entries(rawCredits)) {
    const mode = normalizeModelMode(rawMode)
    if (!MODEL_CONFIGS[mode]) continue

    const amount = Number(rawAmount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const creditsToApply = Math.floor(amount)
    if (creditsToApply <= 0) continue
    credits[mode] = creditsToApply
  }

  return credits
}

function normalizeCreditCodeRedemptionMode(definition) {
  const rawMode = cleanField(
    definition.redemptionMode ??
    definition.oneTimeUseMode ??
    definition.useMode ??
    definition.uses
  ).toLowerCase()

  if (
    definition.unlimitedUses === true ||
    definition.oneTimeUse === false ||
    ['unlimited', 'unlimiteduses', 'infinite', 'none'].includes(rawMode)
  ) {
    return 'unlimited'
  }

  if (
    definition.oneTimeUse === 'identity' ||
    definition.oneTimeUsePerIdentity === true ||
    [
      'identity',
      'peridentity',
      'per-identity',
      'onceperidentity',
      'once-per-identity',
      'one-time-per-identity',
    ].includes(rawMode)
  ) {
    return 'identity'
  }

  if (
    definition.oneTimeUse === true ||
    definition.oneTimeUseGlobal === true ||
    definition.oneTimeUse === 'global' ||
    [
      '',
      'global',
      'once',
      'onetime',
      'one-time',
      'onceglobal',
      'once-global',
      'one-time-global',
    ].includes(rawMode)
  ) {
    return 'global'
  }

  return 'global'
}

function normalizeCreditCodeDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null

  const credits = normalizeCreditCodeCredits(definition.credits)
  if (Object.keys(credits).length === 0) return null

  const expiresAt = definition.expiresAt ?? definition.expireAt ?? definition.expires ?? definition.expireDate
  const expiresAtNumber = expiresAt === undefined || expiresAt === null || expiresAt === ''
    ? null
    : Number(expiresAt)

  return {
    credits,
    redemptionMode: normalizeCreditCodeRedemptionMode(definition),
    expiresAt: Number.isFinite(expiresAtNumber) ? expiresAtNumber : null,
    message: typeof definition.message === 'string' ? definition.message.trim() : '',
  }
}

function isCreditCodeExpired(expiresAt, now) {
  if (expiresAt === null) return false
  const expiresAtMs = expiresAt > 1e12 ? expiresAt : expiresAt * 1000
  return now > expiresAtMs
}

function getCreditCodeIdentitySignals(signals) {
  const preferredSignals = signals.filter((signal) => (
    ['cookie', 'client-id', 'hardware-id'].includes(signal.type)
  ))
  const fallbackSignals = signals.filter((signal) => signal.type !== 'ip')
  return preferredSignals.length > 0
    ? preferredSignals
    : fallbackSignals.length > 0
      ? fallbackSignals
      : signals
}

function getCreditCodeIdentityRedemptionKeys(signals) {
  const redemptionSignals = getCreditCodeIdentitySignals(signals)

  return redemptionSignals.map((signal) => hashSignal(`credit-code-identity:${signal.type}:${signal.valueHash}`))
}

function isCreditCodeAlreadyRedeemed(store, codeHash, definition, identityRedemptionKeys) {
  const redemption = store.creditCodeRedemptions?.[codeHash]

  if (definition.redemptionMode === 'unlimited') return false
  if (!redemption) return false

  if (definition.redemptionMode === 'global') return true

  if (typeof redemption !== 'object') return true
  const identities = redemption.identities && typeof redemption.identities === 'object'
    ? redemption.identities
    : {}

  return identityRedemptionKeys.some((key) => Boolean(identities[key]))
}

function recordCreditCodeRedemption(store, codeHash, definition, identityRedemptionKeys, now) {
  if (definition.redemptionMode === 'unlimited') return

  const redeemedAt = new Date(now).toISOString()
  if (definition.redemptionMode === 'global') {
    store.creditCodeRedemptions[codeHash] = {
      mode: 'global',
      redeemedAt,
    }
    return
  }

  const redemption = store.creditCodeRedemptions[codeHash]
  const identities = redemption && typeof redemption === 'object' && redemption.identities && typeof redemption.identities === 'object'
    ? redemption.identities
    : {}

  for (const key of identityRedemptionKeys) {
    identities[key] = { redeemedAt }
  }

  store.creditCodeRedemptions[codeHash] = {
    mode: 'identity',
    identities,
  }
}

async function redeemCreditCode(req, code) {
  const normalizedCode = normalizeCreditCode(code)
  if (!normalizedCode) {
    const err = new Error('Enter a credit code.')
    err.status = 400
    throw err
  }

  const codes = await readCreditCodeFile()
  const definition = normalizeCreditCodeDefinition(codes[normalizedCode])
  if (!definition) {
    const err = new Error('That credit code was not found.')
    err.status = 404
    throw err
  }

  const now = Date.now()
  if (isCreditCodeExpired(definition.expiresAt, now)) {
    const err = new Error('That credit code has expired.')
    err.status = 410
    throw err
  }

  const signals = getRateLimitSignals(req)
  const creditIdentitySignals = getCreditCodeIdentitySignals(signals)
  const codeHash = hashSignal(`credit-code:${normalizedCode}`)
  const identityRedemptionKeys = getCreditCodeIdentityRedemptionKeys(signals)

  return updateRateLimitStore((store) => {
    store.creditCodeRedemptions ||= {}

    if (isCreditCodeAlreadyRedeemed(store, codeHash, definition, identityRedemptionKeys)) {
      const err = new Error('That credit code has already been redeemed.')
      err.status = 409
      throw err
    }

    for (const signal of creditIdentitySignals) {
      const key = `${signal.type}:${signal.valueHash}`
      const identity = store.identities[key] || {
        type: signal.type,
        valueHash: signal.valueHash,
        firstSeenAt: new Date(now).toISOString(),
        buckets: {},
      }

      identity.lastSeenAt = new Date(now).toISOString()
      for (const [mode, amount] of Object.entries(definition.credits)) {
        addCreditBalance(identity, mode, amount)
      }
      store.identities[key] = identity
    }

    recordCreditCodeRedemption(store, codeHash, definition, identityRedemptionKeys, now)

    return {
      credits: definition.credits,
      message: definition.message,
      rateLimits: getRateLimitSnapshotFromStore(store, signals, now),
    }
  })
}

function normalizeConversationMessages(body, activeMessageId = '') {
  if (Array.isArray(body?.conversationMessages)) {
    const messages = body.conversationMessages
      .filter((message) => (
        message &&
        ['user', 'other'].includes(message.side) &&
        typeof message.text === 'string'
      ))
      .map((message, index) => ({
        id: cleanField(message.id) || `message-${index + 1}`,
        side: message.side,
        text: message.text,
      }))

    const activeIndex = activeMessageId
      ? messages.findIndex((message) => message.id === activeMessageId)
      : -1
    const endIndex = activeIndex === -1 ? messages.length : activeIndex + 1
    const startIndex = Math.max(0, endIndex - MAX_CONVERSATION_MESSAGES)

    return messages.slice(startIndex, endIndex)
  }

  const legacyMessages = []
  const conversationContext = typeof body?.conversationContext === 'string'
    ? body.conversationContext
    : ''
  const replyText = typeof body?.replyText === 'string' ? body.replyText : ''

  if (conversationContext.trim()) {
    legacyMessages.push({ id: 'legacy-context', side: 'other', text: conversationContext })
  }
  if (replyText.trim()) {
    legacyMessages.push({ id: 'legacy-reply', side: 'user', text: replyText })
  }

  return legacyMessages
}

function validateTranslateBody(body) {
  const mode = cleanField(body?.mode) || 'standard'
  const text = typeof body?.text === 'string' ? body.text : ''
  const targetLanguage = cleanField(body?.targetLanguage)
  const sourceLanguage = cleanField(body?.sourceLanguage) || 'Auto-detect'
  const tone = cleanField(body?.tone)
  const modelMode = normalizeModelMode(body?.modelMode)

  if (!['standard', 'conversation'].includes(mode)) {
    return { error: 'Invalid translation mode.' }
  }

  if (!MODEL_CONFIGS[modelMode]) {
    return { error: 'Invalid model mode.' }
  }

  if (mode === 'conversation') {
    const userName = cleanField(body?.userName) || 'You'
    const userLanguage = cleanField(body?.userLanguage)
    const otherName = cleanField(body?.otherName) || 'Other participant'
    const otherLanguage = cleanField(body?.otherLanguage)
    const activeMessageId = cleanField(body?.activeMessageId)
    const conversationMessages = normalizeConversationMessages(body, activeMessageId)
    const activeMessage = conversationMessages.find((message) => message.id === activeMessageId) ||
      conversationMessages[conversationMessages.length - 1]

    if (!activeMessage?.text.trim() || !userLanguage || !otherLanguage) {
      return { error: 'Missing required fields: conversationMessages, userLanguage, otherLanguage' }
    }

    const transcriptLength = conversationMessages.reduce((total, message) => total + message.text.length, 0)
    if (
      transcriptLength > MAX_TEXT_LENGTH ||
      userName.length > MAX_FIELD_LENGTH ||
      userLanguage.length > MAX_FIELD_LENGTH ||
      otherName.length > MAX_FIELD_LENGTH ||
      otherLanguage.length > MAX_FIELD_LENGTH ||
      tone.length > MAX_FIELD_LENGTH ||
      modelMode.length > MAX_FIELD_LENGTH
    ) {
      return { error: 'Request is too large.' }
    }

    const sourceParticipantName = activeMessage.side === 'other' ? otherName : userName
    const targetParticipantName = activeMessage.side === 'other' ? userName : otherName
    const sourceParticipantLanguage = activeMessage.side === 'other' ? otherLanguage : userLanguage
    const targetParticipantLanguage = activeMessage.side === 'other' ? userLanguage : otherLanguage

    return {
      mode,
      text: activeMessage.text,
      sourceLanguage: sourceParticipantLanguage,
      targetLanguage: targetParticipantLanguage,
      tone,
      modelMode,
      userName,
      userLanguage,
      otherName,
      otherLanguage,
      conversationMessages,
      activeMessage,
      sourceParticipantName,
      targetParticipantName,
      sourceParticipantLanguage,
      targetParticipantLanguage,
    }
  }

  if (!text.trim() || !targetLanguage) {
    return { error: 'Missing required fields: text, targetLanguage' }
  }

  if (
    text.length > MAX_TEXT_LENGTH ||
    targetLanguage.length > MAX_FIELD_LENGTH ||
    sourceLanguage.length > MAX_FIELD_LENGTH ||
    tone.length > MAX_FIELD_LENGTH ||
    modelMode.length > MAX_FIELD_LENGTH
  ) {
    return { error: 'Request is too large.' }
  }

  return { mode, text, sourceLanguage, targetLanguage, tone, modelMode }
}

async function readResponseJson(response) {
  const raw = await response.text()

  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return { error: raw || 'Translation provider returned an invalid response' }
  }
}

function buildMessages({ text, sourceLanguage, targetLanguage, tone }) {
  const toneInstruction = tone
    ? `Preserve the meaning while using this tone/style: ${tone}.`
    : 'Preserve the meaning and natural style of the source.'

  const sourceInstruction = sourceLanguage && sourceLanguage !== 'Auto-detect'
    ? `The source language is ${sourceLanguage}.`
    : 'Auto-detect the source language.'

  const systemPrompt = `You are a professional translator with a narrow safety gate.

Translate the user's text into ${targetLanguage}. ${sourceInstruction} ${toneInstruction}

Block only extreme content. Vulgarity, profanity, insults, adult language, disturbing fiction, political opinions, and offensive wording should usually still be translated.

Return a blocked response only when the text clearly:
- asks for instructions, plans, or assistance to commit serious illegal activity or violent harm
- promotes, praises, or incites hate, dehumanization, harassment, or violence against a protected class
- contains sexual content involving minors
- threatens specific real-world violence or celebrates severe harm

Return an untranslatable response when the text or request cannot be translated in a meaningful way, such as total gibberish, no linguistic content, contradictory or impossible language parameters, or an unclear custom language.

The translation should keep the same meaning as the original text.

Return ONLY valid JSON. The status must be exactly one of: translated, blocked, untranslatable.

Use exactly one of these shapes:
{"status":"translated","translation":"translated text here"}
{"status":"blocked","reason":"brief reason"}
{"status":"untranslatable","reason":"brief reason"}`

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: text,
    },
  ]
}

function buildConversationMessages({
  text,
  userName,
  userLanguage,
  otherName,
  otherLanguage,
  conversationMessages,
  activeMessage,
  sourceParticipantName,
  targetParticipantName,
  sourceParticipantLanguage,
  targetParticipantLanguage,
  tone,
}) {
  const toneInstruction = tone
    ? `Use this tone/style unless the conversation context clearly calls for a more natural equivalent: ${tone}.`
    : 'Match the natural tone, politeness, and formality implied by the active message and transcript.'

  const transcript = conversationMessages
    .map((message, index) => {
      const speaker = message.side === 'other' ? otherName : userName
      const language = message.side === 'other' ? otherLanguage : userLanguage
      const marker = message.id === activeMessage.id ? ' [ACTIVE MESSAGE TO TRANSLATE]' : ''
      return `${index + 1}. ${speaker} (${language})${marker}: ${message.text}`
    })
    .join('\n\n')

  const systemPrompt = `You are a professional conversation translator with a narrow safety gate.

The user is copy/pasting between another app and this translator. This is not a live chat.

Participants:
- ${userName} writes in ${userLanguage}
- ${otherName} writes in ${otherLanguage}

Translate ONLY the active message from ${sourceParticipantName} in ${sourceParticipantLanguage} into ${targetParticipantLanguage}, so ${targetParticipantName} can understand it. Use the transcript to resolve names, pronouns, direct address, relationship, politeness, register, implied subjects, and language-specific habits such as naturally using a person's name or honorifics. Do not answer the conversation, summarize it, or translate any non-active message.

${toneInstruction}

Block only extreme content. Vulgarity, profanity, insults, adult language, disturbing fiction, political opinions, and offensive wording should usually still be translated.

Return a blocked response only when the active message clearly:
- asks for instructions, plans, or assistance to commit serious illegal activity or violent harm
- promotes, praises, or incites hate, dehumanization, harassment, or violence against a protected class
- contains sexual content involving minors
- threatens specific real-world violence or celebrates severe harm

Return an untranslatable response when the active message or request cannot be translated in a meaningful way, such as total gibberish, no linguistic content, contradictory or impossible language parameters, or an unclear custom language.

Return ONLY valid JSON. The status must be exactly one of: translated, blocked, untranslatable.

Use exactly one of these shapes:
{"status":"translated","translation":"translated active message here"}
{"status":"blocked","reason":"brief reason"}
{"status":"untranslatable","reason":"brief reason"}`

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: `Transcript:
${transcript}

Active message from ${sourceParticipantName} in ${sourceParticipantLanguage} to translate into ${targetParticipantLanguage}:
${text}`,
    },
  ]
}

function buildRequestMessages(validation) {
  return validation.mode === 'conversation'
    ? buildConversationMessages(validation)
    : buildMessages(validation)
}

// const client = new OpenRouter({
//   apiKey: process.env.OPENROUTER_API_KEY,
// })

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    providerConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    defaultModelMode: DEFAULT_MODEL_MODE,
    models: OPENROUTER_MODELS,
    modelModes: Object.fromEntries(
      Object.entries(MODEL_CONFIGS).map(([mode, config]) => [mode, {
        label: config.label,
        model: config.model,
        displayModel: config.displayModel,
        limit: config.limit,
        windowHours: 24,
      }])
    ),
  })
})

app.post('/api/rate-limits', async (req, res) => {
  try {
    res.json({ rateLimits: await getRateLimitSnapshot(req) })
  } catch (err) {
    console.error('Rate limit snapshot error:', err)
    res.status(500).json({ error: 'Rate limit store is not available.' })
  }
})

app.post('/api/credit-codes/redeem', async (req, res) => {
  try {
    const redemption = await redeemCreditCode(req, req.body?.code)
    res.json({
      redeemed: true,
      credits: redemption.credits,
      message: redemption.message,
      rateLimits: redemption.rateLimits,
    })
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('Credit code redemption error:', err)
    res.status(status).json({ error: err.message || 'Credit code could not be redeemed.' })
  }
})

app.post('/api/translate', async (req, res) => {
  const validation = validateTranslateBody(req.body)

  if (validation.error) {
    return res.status(400).json({ error: validation.error })
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Translation service is not configured.' })
  }

  let rateLimit
  try {
    rateLimit = await recordRateLimit(req, validation.modelMode)
  } catch (err) {
    console.error('Rate limit error:', err)
    return res.status(500).json({ error: 'Rate limit store is not available.' })
  }

  if (!rateLimit.allowed) {
    return res.status(429).json({
      limitExceeded: true,
      error: `${rateLimit.usage.label} limit reached.`,
      rateLimit: rateLimit.usage,
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let shouldRefundRateLimit = true
  try {
    const headers = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    }
    const payload = {
      model: OPENROUTER_MODELS[validation.modelMode],
      messages: buildRequestMessages(validation),
      temperature: 0.2,
    }

    const completion = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const data = await readResponseJson(completion)

    if (!completion.ok) {
      throw new Error(data.error?.message || data.error || 'Translation request failed')
    }

    const providerMessage = getProviderMessage(data)
    if (!providerMessage) {
      throw new ProviderResponseError('Translation provider response did not include message content.')
    }

    const parsed = parseModelResponse(providerMessage)
    if (parsed.status === 'blocked') {
      const refundedRateLimit = await refundRateLimit(req, validation.modelMode, rateLimit.chargeType)
      return res.status(422).json({
        rejected: true,
        rejectionType: 'safety',
        error: BLOCKED_TRANSLATION_ERROR,
        reason: parsed.reason || 'Safety policy',
        rateLimit: refundedRateLimit,
      })
    }

    if (parsed.status === 'untranslatable') {
      const refundedRateLimit = await refundRateLimit(req, validation.modelMode, rateLimit.chargeType)
      return res.status(422).json({
        rejected: true,
        rejectionType: 'untranslatable',
        error: UNTRANSLATABLE_ERROR,
        reason: parsed.reason || 'The text or language request was not meaningfully translatable.',
        rateLimit: refundedRateLimit,
      })
    }

    if (parsed.status === 'translated') {
      const translation = cleanField(parsed.translation)
      if (!translation) throw new Error('Translation response was empty')
      shouldRefundRateLimit = false
      return res.json({ translation, rateLimit: rateLimit.usage })
    }

    throw new ProviderResponseError(
      `Translation provider returned unknown status: ${cleanField(parsed.status) || 'missing'}.`
    )
  } catch (err) {
    console.error('Translation error:', err)
    let refundedRateLimit = null
    if (shouldRefundRateLimit) {
      try {
        refundedRateLimit = await refundRateLimit(req, validation.modelMode, rateLimit?.chargeType)
      } catch (refundErr) {
        console.error('Rate limit refund error:', refundErr)
      }
    }
    const status = err.name === 'AbortError' ? 504 : err.status || 502
    const error = err.publicMessage || 'Translation failed. Check your API key and try again.'
    res.status(status).json({ error, ...(refundedRateLimit ? { rateLimit: refundedRateLimit } : {}) })
  } finally {
    clearTimeout(timeout)
  }
})

app.use(express.static('dist'));
app.get('*', (req, res) => res.sendFile('index.html', { root: 'dist' }));

if (process.argv[1] === __filename) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

export { parseModelResponse, escapeJsonStringControlChars }
