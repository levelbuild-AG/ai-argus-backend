# White Labeling & Branding Notes

## Overview
- LibreChat reads white-label assets from `/app/librechat-custom` and serves them at `/librechat-custom/*`.
- Login, registration, and chat footers are rendered by React components in `client/src/components/Auth` and `client/src/components/Chat`.
- The backend Express server wires static asset serving inside `api/server/index.js` using the custom assets path exported from `api/config/paths.js`.
- Deployment relies on Docker builds that copy the entire workspace (respecting `.dockerignore`) into `/app`.

## Asset Placement
1. Keep brand-specific files under `librechat-custom/`. For logos we currently use `librechat-custom/logos/levelbuild_logo_square_small.png`.
2. When adding new assets, make sure `.dockerignore` does **not** exclude the directory or pattern. As of Nov 2025 we removed the old `librechat*` ignore entries so the folder is shipped with every image.
3. During development you can hotlink to these assets via `/librechat-custom/...`. The same paths work in production because the API container exposes them statically.

## Frontend Touchpoints
- `client/src/components/Auth/AuthLayout.tsx`: sets the login logo source. Update the `logoSrc` constant or logic when changing logos.
- `client/src/components/Auth/Footer.tsx`: renders the login/registration footer using `ReactMarkdown`. Adjust `defaultFooter` for new text or links.
- `client/src/components/Chat/Footer.tsx`: uses the same copy when no custom footer is provided from settings.

When modifying these files, keep the text short enough for small screens and prefer Markdown links so future content updates are simple.

### Legal Links (Privacy & Terms)
- The footer component reads `privacyPolicy` and `termsOfService` from `startupConfig.interface` (sourced from `librechat.yaml`).
- A guard (`const showLegalLinks = false`) keeps the links hidden for now. To re-enable them, switch that flag to `true` in `client/src/components/Auth/Footer.tsx`.
- To customize the destination URLs, edit `librechat.yaml` (or the relevant override) with:
	```yaml
	interface:
		privacyPolicy:
			externalUrl: "https://levelbuild.com/privacy"
			openNewTab: true
		termsOfService:
			externalUrl: "https://levelbuild.com/terms"
			openNewTab: true
	```
- After toggling the flag or updating the YAML, redeploy so the SPA receives the new startup config.

## Backend Serving
- `api/config/paths.js` defines `customAssets` (defaults to `<repo>/librechat-custom`).
- `api/server/index.js` checks whether the directory exists and, if so, exposes it via `app.use('/librechat-custom', staticCache(...))`.
- No restart logic is required beyond redeploying the API container.

If additional static folders are needed (e.g., brochure PDFs), extend `lib/customAssets` but keep the same URL prefix to avoid CDN/cache changes.

## Deployment Considerations
1. Ensure assets are part of the Docker build context (`.dockerignore` must allow them).
2. Our deploy helper (`scripts/deploy_to_vm.sh`) now runs `docker compose up --build -d` remotely, forcing the VM to rebuild with the latest `librechat-custom` contents.
3. If you ever add large media files, consider compressing them; huge assets slow down `docker compose build` because everything is copied into `/app`.
4. For emergency overrides you can temporarily bind-mount the folder via `docker-compose.override.yml`, but commit a note explaining why so it does not drift from the image.

## Verification Checklist
- Locally: `docker compose up api` then visit `http://localhost:3080/librechat-custom/logos/<file>.png` and the login page.
- Remote: `ssh $VM docker exec -it LibreChat ls /app/librechat-custom` to confirm the files exist after deploy.
- Browser cache gotchas: hard refresh (Ctrl+Shift+R) if the logo seems unchanged.

## Future White-Label Tasks
- Update `client/public/brand/*` if you need favicons or manifest colors.
- For multi-tenant branding, consider reading asset metadata from the database and serving tenant-specific paths; the current setup is global.
- Document any new Markdown conventions (e.g., legal copy) inside this file so future branding swaps remain predictable.
