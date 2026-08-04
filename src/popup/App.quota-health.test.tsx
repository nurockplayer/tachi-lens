// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { QuotaHealthResult } from '@/shared/messages'
import { App } from './App'

const COOLDOWN_UNTIL = 1_750_000_000_000
const RECOVERY_AT = 1_750_000_000_000

const healthyResult: QuotaHealthResult = {
  quotaKey: 'default',
  status: 'healthy',
  snapshotVersion: 3,
  snapshotStatus: 'complete',
}

const cooldownResult: QuotaHealthResult = {
  quotaKey: 'gemini-2.5-pro',
  status: 'cooldown',
  denialReason: 'cooldown',
  providerDay: '2026-08-03',
  snapshotVersion: 3,
  snapshotStatus: 'complete',
  cooldownUntil: COOLDOWN_UNTIL,
}

const clockRollbackResult: QuotaHealthResult = {
  quotaKey: 'gemini-2.5-flash',
  status: 'clock_rollback',
  denialReason: 'clock_rollback',
  snapshotVersion: 3,
  snapshotStatus: 'complete',
  recoveryAt: RECOVERY_AT,
}

const untrustedMigrationResult: QuotaHealthResult = {
  quotaKey: 'legacy',
  status: 'untrusted_migration',
  snapshotVersion: 2,
  snapshotStatus: 'untrusted_migration',
}

const malformedResult: QuotaHealthResult = {
  quotaKey: 'gemini-2.5-pro',
  status: 'malformed_snapshot',
  snapshotVersion: 3,
  snapshotStatus: 'complete',
}

const unsupportedResult: QuotaHealthResult = {
  quotaKey: 'default',
  status: 'unsupported_version',
  snapshotVersion: 99,
  snapshotStatus: 'unsupported_version',
}

/** Renders App with a stub SW returning the given quota-health payload. */
const sendMessageMock = vi.fn()
const renderWithQuotaHealth = (payload: QuotaHealthResult[]) => {
  sendMessageMock.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'get_quota_health') {
      return { type: 'quota_health_result', payload }
    }
    if (message.type === 'get_diagnostics') {
      return { type: 'diagnostics_snapshot', payload: { events: [] } }
    }
    if (message.type === 'get_api_key_preview') {
      return { type: 'api_key_preview', payload: { preview: '' } }
    }
    return undefined
  })
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
      },
    },
    runtime: {
      sendMessage: sendMessageMock,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { query: vi.fn(async () => []) },
  })
  return render(<App />)
}

const getSendMessageTypes = (): string[] => {
  return sendMessageMock.mock.calls.map(([message]) => (message as { type: string }).type)
}

describe('Popup Gemini quota health', () => {
  afterEach(() => {
    sendMessageMock.mockClear()
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders every health status with a distinct label and description', async () => {
    renderWithQuotaHealth([
      healthyResult,
      cooldownResult,
      clockRollbackResult,
      untrustedMigrationResult,
      malformedResult,
      unsupportedResult,
    ])

    expect(await screen.findByText('Gemini 配額健康狀態')).toBeTruthy()
    expect(screen.getByText(/default：正常/)).toBeTruthy()
    expect(screen.getByText(/gemini-2\.5-pro：冷卻中/)).toBeTruthy()
    expect(screen.getByText(/gemini-2\.5-flash：時鐘回撥/)).toBeTruthy()
    expect(screen.getByText(/legacy：不可信的遷移/)).toBeTruthy()
    expect(screen.getByText(/gemini-2\.5-pro：資料異常/)).toBeTruthy()
    expect(screen.getByText(/default：不支援的版本/)).toBeTruthy()

    expect(screen.getByText('Gemini 配額運作正常。')).toBeTruthy()
    expect(screen.getByText('Gemini 正在冷卻，暫停送出請求以保護配額。')).toBeTruthy()
    expect(screen.getByText('偵測到時鐘回撥，Gemini 已暫停以保護配額正確性。')).toBeTruthy()
    expect(screen.getByText('偵測到不可信的資料遷移，Gemini 已停用以保護配額正確性。')).toBeTruthy()
    expect(screen.getByText('偵測到損壞的配額資料，Gemini 已停用以保護配額正確性。')).toBeTruthy()
    expect(screen.getByText('偵測到不支援的配額資料版本，Gemini 已停用以保護配額正確性。')).toBeTruthy()
  })

  it('shows cooldown denial reason, provider day and next recovery time when provided', async () => {
    renderWithQuotaHealth([cooldownResult])

    await screen.findByText(/gemini-2\.5-pro：冷卻中/)
    expect(screen.getByText(/拒絕原因：冷卻中/)).toBeTruthy()
    expect(screen.getByText(/目前配額日：2026-08-03/)).toBeTruthy()
    expect(
      screen.getByText((content) =>
        content.includes('冷卻結束：') && content.includes(new Date(COOLDOWN_UNTIL).toLocaleString()),
      ),
    ).toBeTruthy()
  })

  it('shows clock rollback recovery time when provided', async () => {
    renderWithQuotaHealth([clockRollbackResult])

    await screen.findByText(/gemini-2\.5-flash：時鐘回撥/)
    expect(screen.getByText(/拒絕原因：時鐘回撥/)).toBeTruthy()
    expect(
      screen.getByText((content) =>
        content.includes('自動恢復時間：') && content.includes(new Date(RECOVERY_AT).toLocaleString()),
      ),
    ).toBeTruthy()
  })

  it('omits optional fields when the contract does not provide them', async () => {
    renderWithQuotaHealth([healthyResult])

    await screen.findByText(/default：正常/)
    expect(screen.queryByText(/拒絕原因/)).toBeNull()
    expect(screen.queryByText(/目前配額日/)).toBeNull()
    expect(screen.queryByText(/冷卻結束/)).toBeNull()
    expect(screen.queryByText(/自動恢復時間/)).toBeNull()
  })

  it('does not present a healthy state as needing repair', async () => {
    renderWithQuotaHealth([healthyResult])

    await screen.findByText(/default：正常/)
    expect(screen.queryByRole('button', { name: /重設|reset|修復|repair/i })).toBeNull()
  })

  it('notes DeepSeek overflow for fail-closed integrity statuses but not for healthy or cooldown', async () => {
    const overflowNote = 'Gemini 暫停期間，仍可改用 DeepSeek 進行翻譯。'

    const { unmount: unmountIntegrity } = renderWithQuotaHealth([untrustedMigrationResult])
    expect(await screen.findByText(/legacy：不可信的遷移/)).toBeTruthy()
    expect(screen.getByText(overflowNote)).toBeTruthy()
    unmountIntegrity()

    cleanup()

    renderWithQuotaHealth([clockRollbackResult, malformedResult, unsupportedResult])
    await screen.findByText(/gemini-2\.5-flash：時鐘回撥/)
    expect(screen.getAllByText(overflowNote)).toHaveLength(3)
  })

  it('does not show DeepSeek overflow for healthy or cooldown states', async () => {
    const overflowNote = 'Gemini 暫停期間，仍可改用 DeepSeek 進行翻譯。'

    renderWithQuotaHealth([healthyResult, cooldownResult])
    await screen.findByText(/gemini-2\.5-pro：冷卻中/)
    expect(screen.queryByText(overflowNote)).toBeNull()
  })

  it('renders nothing for quota health when the SW returns no results', async () => {
    renderWithQuotaHealth([])

    expect(screen.queryByText('Gemini 配額健康狀態')).toBeNull()
  })

  it('only issues read-only messages and never mutates quota state', async () => {
    renderWithQuotaHealth([healthyResult, cooldownResult, clockRollbackResult])

    await screen.findByText(/gemini-2\.5-flash：時鐘回撥/)

    const mutationPattern = /reset|repair|delete_quota|save_quota|clear_quota|purge/i
    for (const type of getSendMessageTypes()) {
      expect(type).not.toMatch(mutationPattern)
    }
    expect(getSendMessageTypes()).toContain('get_quota_health')
  })
})
