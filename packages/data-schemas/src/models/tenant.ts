import tenantSchema from '~/schema/tenant';
import type * as t from '~/types';

/**
 * Creates or returns the Tenant model using the provided mongoose instance and schema.
 * 
 * IMPORTANT: Tenant model must ALWAYS use the system database connection (not tenant connections).
 * Tenant records are stored in the system DB and are used to resolve tenant database URIs.
 */
export function createTenantModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.Tenant || mongoose.model<t.ITenant>('Tenant', tenantSchema);
}
