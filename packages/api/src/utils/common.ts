import { AuthType } from 'librechat-data-provider';

/**
 * Checks if the given value is truthy by being either the boolean `true` or a string
 * that case-insensitively matches 'true'.
 *
 * @param value - The value to check.
 * @returns Returns `true` if the value is the boolean `true` or a case-insensitive
 *                    match for the string 'true', otherwise returns `false`.
 * @example
 *
 * isEnabled("True");  // returns true
 * isEnabled("TRUE");  // returns true
 * isEnabled(true);    // returns true
 * isEnabled("false"); // returns false
 * isEnabled(false);   // returns false
 * isEnabled(null);    // returns false
 * isEnabled();        // returns false
 */
export function isEnabled(value?: string | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase().trim() === 'true';
  }
  return false;
}

/**
 * Checks if the provided value is 'user_provided'.
 *
 * @param value - The value to check.
 * @returns - Returns true if the value is 'user_provided', otherwise false.
 */
export const isUserProvided = (value?: string): boolean => value === AuthType.USER_PROVIDED;

/**
 * Checks if multi-tenancy is enabled via the MULTI_TENANCY_ENABLED environment variable.
 * When disabled (default), the system operates in single-tenant mode.
 *
 * @returns Returns `true` if MULTI_TENANCY_ENABLED is set to 'true', otherwise returns `false`.
 * @example
 *
 * isMultiTenancyEnabled(); // returns false (default)
 * // With MULTI_TENANCY_ENABLED=true
 * isMultiTenancyEnabled(); // returns true
 */
export function isMultiTenancyEnabled(): boolean {
  return isEnabled(process.env.MULTI_TENANCY_ENABLED);
}

/**
 * @param values
 */
export function optionalChainWithEmptyCheck(
  ...values: (string | number | undefined)[]
): string | number | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return values[values.length - 1];
}
