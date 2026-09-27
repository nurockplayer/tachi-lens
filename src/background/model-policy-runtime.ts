import { AUTO_MODEL, resolvePolicyModel, type ModelPolicySnapshot, type ResolvedPolicyModel } from '@/providers/model-policy'
import type { UserSettings } from '@/storage/settings'
import type { ModelPolicySnapshotPayload } from '@/shared/model-policy-messages'

/** One snapshot supplies a batch's primary and cross-provider fallback identities. */
export class ModelPolicyRuntime {
  private resolutions: ModelPolicySnapshotPayload['resolutions'] = []

  constructor(private readonly getSnapshot: () => Promise<ModelPolicySnapshot>) {}

  private resolve(snapshot: ModelPolicySnapshot, provider: 'gemini' | 'deepseek', workload: 'chat' | 'speech', selection: string): ResolvedPolicyModel {
    const resolved = resolvePolicyModel(snapshot, provider, workload, selection)
    // User-controlled invalid pins must never enter privacy-safe diagnostics.
    if (snapshot.manifest.policies.some(policy => policy.provider === provider && policy.workload === workload && policy.models.some(model => model.id === resolved.model))) {
      this.resolutions = [{ ...resolved, timestamp: Date.now() }, ...this.resolutions].slice(0, 20)
    }
    return resolved
  }

  async chatSettings(settings: UserSettings) {
    if (settings.selectedProvider !== 'gemini' && settings.selectedProvider !== 'deepseek') return settings
    const snapshot = await this.getSnapshot()
    const primary = this.resolve(snapshot, settings.selectedProvider, 'chat', settings.selectedModel)
    const fallback = settings.selectedProvider === 'gemini'
      ? this.resolve(snapshot, 'deepseek', 'chat', AUTO_MODEL)
      : primary
    return { ...settings, selectedModel: primary.model, modelConfiguration: primary.configuration, deepseekFallbackModel: fallback.model }
  }

  async speechSettings(settings: UserSettings) {
    const snapshot = await this.getSnapshot()
    const resolved = this.resolve(snapshot, 'gemini', 'speech', settings.speechConfig.speechModel)
    return { ...settings, speechConfig: { ...settings.speechConfig, speechModel: resolved.model }, speechModelConfiguration: resolved.configuration }
  }

  async snapshot(): Promise<ModelPolicySnapshotPayload> {
    return { ...await this.getSnapshot(), resolutions: [...this.resolutions] }
  }
}
