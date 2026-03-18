/* eslint-disable no-console */
const { runGoogleVerification } = require('./verify-google-helper');

async function main() {
  const apiUrl = process.env.API_URL || 'http://localhost:3082';

  try {
    const result = await runGoogleVerification({ apiUrl });
    console.log(
      '[verify-google-levelbuild] SUCCESS: ext/v2 Google/Gemini verified with conversationId=',
      result.conversationId,
    );
    process.exit(0);
  } catch (err) {
    console.error('[verify-google-levelbuild] FAILED:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[verify-google-levelbuild] Unhandled error', err);
    process.exit(1);
  });
}

module.exports = { main };

