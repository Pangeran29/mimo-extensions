import {
  DEFAULT_SETTINGS,
  DEEPINFRA_MODEL,
  type AssistantSettings,
  type AssistantProvider,
} from './types';
export const providerOf = (settings: Pick<AssistantSettings, 'provider'>): AssistantProvider =>
  settings.provider === 'deepinfra' ? 'deepinfra' : 'hpop';
export const modelFor = (provider: AssistantProvider) =>
  provider === 'deepinfra' ? DEEPINFRA_MODEL : DEFAULT_SETTINGS.model;
export function normalizeSettings(value?: Partial<AssistantSettings>): AssistantSettings {
  if (value?.provider !== undefined && !['hpop', 'deepinfra'].includes(value.provider))
    throw Error('Unknown notes provider.');
  const provider = providerOf(value ?? {});
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    provider,
    model: modelFor(provider),
    benchmarkPassed: false,
  };
}
