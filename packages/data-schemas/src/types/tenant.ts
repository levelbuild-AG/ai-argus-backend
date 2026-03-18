import type { Document } from 'mongoose';

export interface ITenant extends Document {
  tenantId: string;
  name?: string;
  dbUri: string;
  status: 'active' | 'suspended' | 'deleted';
  configVersion?: number;
  config?: {
    googleServiceKeyFile?: string;
    googleApiKey?: string;
    openAiApiKey?: string;
    anthropicApiKey?: string;
    fluxApiKey?: string;
    bedrock?: {
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
      sessionToken?: string;
      endpointHost?: string;
      roleArn?: string;
    };
    // Custom endpoint configurations (tenant-level overlays)
    // Maps endpointId (normalized endpoint name) to tenant-specific config
    customEndpoints?: Record<string, {
      apiKey: string;        // Required: API key for this custom endpoint
      baseURL: string;       // Required: Base URL for this custom endpoint
      modelDefaults?: Record<string, unknown>;  // Optional: Model defaults
      headers?: Record<string, string>;         // Optional: Custom headers
    }>;
    // ... other provider keys can be added here
    librechatSettings?: Record<string, unknown>;
    rag?: {
      postgresUri?: string;
      vectorDbType?: string;
    };
    storage?: {
      provider?: string;
      bucket?: string;
      container?: string;
      basePath?: string;
      prefix?: string;
    };
  };
  createdAt?: Date;
  updatedAt?: Date;
}
