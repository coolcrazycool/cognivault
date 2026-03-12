import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

export function initTracing(endpoint: string): void {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'cognivault' }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
}

export function shutdownTracing(): Promise<void> {
  return sdk?.shutdown() ?? Promise.resolve();
}
