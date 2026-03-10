/**
 * license.ts
 *
 * Skales+ Tier System — Foundation layer.
 *
 * Tiers:
 *   free  — default, all core features enabled
 *   plus  — Skales+ subscription (future)
 *   pro   — Skales Pro / team licence (future)
 *
 * Current behaviour:
 *   - getUserTier() always returns 'free' (no licence server yet)
 *   - isFeatureAvailable() always returns true (all features on during beta)
 *   - FEATURE_CONFIG describes which tier each feature belongs to — used by
 *     Settings UI to show "Skales+" badges next to gated features.
 *
 * When a licence server is ready, replace getUserTier() with a real lookup
 * (e.g. read from ~/.skales-data/licence.json, validate JWT, etc.).
 */

export type Tier = 'free' | 'plus' | 'pro';

/** Map of feature keys → minimum required tier */
export const FEATURE_CONFIG: Record<string, Tier> = {
    // Core — always free
    chat:                   'free',
    tools:                  'free',
    skills:                 'free',
    telegram:               'free',
    buddy:                  'free',
    sessions:               'free',

    // Skales+ features (future gate)
    multi_agent:            'plus',
    voice_chat:             'plus',
    image_generation:       'plus',
    video_generation:       'plus',
    autopilot:              'plus',
    scheduled_tasks:        'plus',

    // Pro features (future gate)
    team_sync:              'pro',
    priority_support:       'pro',
    custom_models:          'pro',
};

const TIER_RANK: Record<Tier, number> = { free: 0, plus: 1, pro: 2 };

/**
 * Returns the current user's tier.
 *
 * During beta / v5.5 launch this always returns 'free' so that every feature
 * remains accessible. Replace with real licence logic when ready.
 */
export function getUserTier(): Tier {
    // TODO: read from ~/.skales-data/licence.json once licence server exists
    return 'free';
}

/**
 * Returns true if the given feature is available for the current user's tier.
 *
 * During beta this always returns true regardless of tier — no features are
 * locked yet. The gate logic is in place for when tiers go live.
 */
export function isFeatureAvailable(featureKey: string): boolean {
    // Beta override: everything is available
    const BETA_OPEN = true;
    if (BETA_OPEN) return true;

    const required = FEATURE_CONFIG[featureKey];
    if (!required) return true; // unknown features default to available

    const userTier = getUserTier();
    return TIER_RANK[userTier] >= TIER_RANK[required];
}

/**
 * Returns the minimum tier label for a feature, or null if it's free.
 * Used by the Settings UI to render "Skales+" / "Pro" badges.
 */
export function getFeatureTierLabel(featureKey: string): string | null {
    const required = FEATURE_CONFIG[featureKey];
    if (!required || required === 'free') return null;
    if (required === 'plus') return 'Skales+';
    if (required === 'pro')  return 'Pro';
    return null;
}
