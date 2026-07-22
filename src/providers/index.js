import { MockProvider } from './mock-provider.js';
import { SmartPingProvider } from './smartping-provider.js';

export function createProvider(config) {
  if (config.providerName === 'mock') return new MockProvider();
  if (config.providerName === 'smartping') {
    return new SmartPingProvider(config.smartPing);
  }
  throw new Error(`Unsupported CALL_PROVIDER: ${config.providerName}`);
}
