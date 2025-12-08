// ==== LB Chat: re-entrancy guard (reload-safe) ====
if (window.__lbChatInitInProgress) {
    console.warn("[LB Chat] Init skipped: another init is in progress.");
    return;
}
window.__lbChatInitInProgress = true;
window.addEventListener("pagehide", () => { window.__lbChatInitInProgress = false; }, { once: true });
window.addEventListener("beforeunload", () => { window.__lbChatInitInProgress = false; }, { once: true });
// ==================================================

(function () {
    const CHAT_URL   = "https://levelbuild-argus-chat.levelbuild.com/";
    const OVERLAY_ID = "__argusChatOverlay";
    const IFRAME_ID  = "__argusChatIframe";
    const LOADER_ID  = "__argusChatLoader";
    const ERROR_ID   = "__argusChatError";
    const STYLE_ID   = "__argusChatStyle";
    const FETCH_TIMEOUT_MS = 15000;
    const LOAD_TIMEOUT_MS  = 20000;

    // Prefer #wrapper (covers full content area), fall back to .slideAll
    const host =
        document.querySelector("#wrapper") ||
        document.querySelector(".slideAll");

    if (!host) {
        console.warn("[Argus Chat] Host container (#wrapper / .slideAll) not found – aborting init.");
        return;
    }

    // Make sure host can be a positioning context for our absolute overlay
    const computedPos = window.getComputedStyle(host).position;
    if (computedPos === "static" || !computedPos) {
        host.style.position = "relative";
    }

    // Clean up old overlay if re-run
    const oldOverlay = document.getElementById(OVERLAY_ID);
    if (oldOverlay && oldOverlay.parentNode) {
        oldOverlay.parentNode.removeChild(oldOverlay);
    }

    // Inject spinner animation once
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            @keyframes __argusSpin {
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    // === Overlay that covers entire host (no aspect-ratio funny business) ===
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        width: "100%",
        height: "100%",
        backgroundColor: "#ffffff",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        zIndex: "50"
    });
    host.appendChild(overlay);

    // Loader
    const loader = document.createElement("div");
    loader.id = LOADER_ID;
    Object.assign(loader.style, {
        flex: "1",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: "#111827",
        padding: "16px",
        textAlign: "center",
        boxSizing: "border-box"
    });
    loader.innerHTML = `
        <div style="
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: 3px solid rgba(15,23,42,0.15);
            border-top-color: rgba(157,76,232,0.95);
            animation: __argusSpin 0.8s linear infinite;
        "></div>
        <div style="font-size:14px;">Loading interface…</div>
    `;
    overlay.appendChild(loader);

    // Error box
    const errorBox = document.createElement("div");
    errorBox.id = ERROR_ID;
    Object.assign(errorBox.style, {
        flex: "1",
        display: "none",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        boxSizing: "border-box",
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: "#991b1b",
        textAlign: "center"
    });
    errorBox.innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;">
            Failed to load chat interface
        </div>
        <div class="__argusErrorDetails" style="font-size:14px;color:#7f1d1d;"></div>
    `;
    overlay.appendChild(errorBox);
    const errorDetails = errorBox.querySelector(".__argusErrorDetails");

    function showLoader() {
        loader.style.display = "flex";
        errorBox.style.display = "none";
        iframe.style.display = "none";
    }

    function showError(msg) {
        loader.style.display = "none";
        errorBox.style.display = "flex";
        iframe.style.display = "none";
        if (errorDetails) errorDetails.textContent = msg;
        console.error("[Argus Chat]", msg);
    }

    function showIframe() {
        loader.style.display = "none";
        errorBox.style.display = "none";
        iframe.style.display = "block";
    }

    // Iframe (fills overlay)
    const iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    iframe.allow = "clipboard-read; clipboard-write";
    Object.assign(iframe.style, {
        border: "0",
        width: "100%",
        height: "100%",
        display: "none",
        boxSizing: "border-box"
    });
    overlay.appendChild(iframe);

    showLoader();

    let iframeLoaded = false;

    iframe.addEventListener("load", () => {
        iframeLoaded = true;
        if (errorBox.style.display === "none") {
            showIframe();
        }
    });

    // Start loading iframe immediately
    iframe.src = CHAT_URL;

    // Probe endpoint for visible HTTP errors (502, etc.)
    if (window.fetch) {
        (async () => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

                const resp = await fetch(CHAT_URL, {
                    method: "GET",
                    mode: "cors",
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!resp.ok) {
                    showError(`${resp.status} - ${resp.statusText || "Error"}`);
                    return;
                }
                // If OK, just let iframe load event take over
            } catch (err) {
                setTimeout(() => {
                    if (!iframeLoaded && errorBox.style.display === "none") {
                        if (err && err.name === "AbortError") {
                            showError("Connection timed out while contacting the chat service.");
                        } else {
                            showError("Network or CORS error while contacting the chat service.");
                        }
                    }
                }, 3000);
            }
        })();
    }

    // Ultimate fallback
    setTimeout(() => {
        if (!iframeLoaded && errorBox.style.display === "none") {
            showError("Timeout while loading the chat interface.");
        }
    }, LOAD_TIMEOUT_MS);
})();