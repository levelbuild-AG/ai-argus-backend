import { Schema } from 'mongoose';
import { ITenant } from '~/types';

const tenantSchema = new Schema<ITenant>(
  {
    tenantId: {
      type: String,
      required: [true, "can't be blank"],
      unique: true,
      index: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: false,
    },
    dbUri: {
      type: String,
      required: [true, "can't be blank"],
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'deleted'],
      default: 'active',
      index: true,
    },
    configVersion: {
      type: Number,
      default: 0,
    },
    config: {
      type: {
        // AI Provider Credentials (encrypted at rest)
        googleServiceKeyFile: String,
        googleApiKey: String,
        openAiApiKey: String,
        anthropicApiKey: String,
        fluxApiKey: String,
        // Bedrock AWS credentials (structured config)
        bedrock: {
          type: {
            accessKeyId: String,      // AWS Access Key ID (required)
            secretAccessKey: String,   // AWS Secret Access Key (required)
            region: String,            // AWS Region (required, e.g., 'us-east-1')
            sessionToken: String,      // Optional: AWS Session Token (for temporary credentials)
            endpointHost: String,     // Optional: Custom endpoint host (reverse proxy)
            roleArn: String,           // Optional: IAM Role ARN (for assume-role)
          },
          required: false,
        },
        // Custom endpoint configurations (tenant-level overlays)
        // Maps endpointId (normalized endpoint name) to tenant-specific config
        customEndpoints: Schema.Types.Mixed, // Record<endpointId, { apiKey: string, baseURL: string, modelDefaults?: object, headers?: object }>
        // ... other provider keys can be added here
        
        // LibreChat Settings (overrides for librechat.yaml)
        librechatSettings: Schema.Types.Mixed,
        
        // RAG / Vector Store Configuration (infrastructure config, sensitive)
        rag: {
          type: {
            postgresUri: String, // Tenant-specific Postgres connection string for vector store
            vectorDbType: String, // Optional: 'pgvector' or 'atlas-mongo' (defaults to pgvector)
          },
          required: false,
        },
        
        // File Storage Configuration (infrastructure config, sensitive)
        storage: {
          type: {
            provider: String, // Storage provider: 's3', 'local', 'firebase', 'azure_blob'
            bucket: String,   // S3 bucket name (if provider === 's3')
            container: String, // Azure container name (if provider === 'azure_blob')
            basePath: String,  // Local base path (if provider === 'local')
            prefix: String,    // Optional prefix for shared buckets/containers (e.g., 'tenant/${tenantId}/')
          },
          required: false,
        },
      },
      required: false,
    },
  },
  { timestamps: true },
);

export default tenantSchema;
