import path from "node:path";

/**
 * Strips authentication credentials and normalizes Git remote URLs to standard web URLs.
 * Handles HTTPS, HTTP, SSH, and SCP-like Git remote formats.
 */
export function sanitizeGitUrl(rawUrl: string): string | undefined {
    if (!rawUrl || typeof rawUrl !== "string") {
        return undefined;
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return undefined;
    }

    // Handle SCP-like git remote: git@github.com:owner/repo.git
    const scpMatch = trimmed.match(/^(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9._-]+):([a-zA-Z0-9._/~-]+?)(?:\.git)?\/?$/);
    if (scpMatch) {
        const [, user, host, repoPath] = scpMatch;
        // Avoid matching Windows drive letters like C:\path
        if (host.length > 1 && (user || host.includes("."))) {
            const cleanPath = repoPath.replace(/^\/+/, "");
            return `https://${host}/${cleanPath}`;
        }
    }

    try {
        const parsed = new URL(trimmed);

        if (!["http:", "https:", "git:", "ssh:"].includes(parsed.protocol)) {
            return undefined;
        }

        // Discord buttons only accept http/https URLs
        const protocol = (parsed.protocol === "http:" || parsed.protocol === "https:")
            ? parsed.protocol
            : "https:";

        // Strip credentials
        parsed.username = "";
        parsed.password = "";

        const cleanPath = parsed.pathname.replace(/\.git\/?$/, "").replace(/\/+$/, "");
        if (!cleanPath || cleanPath === "/") {
            return `${protocol}//${parsed.host}`;
        }

        return `${protocol}//${parsed.host}${cleanPath}`;
    } catch {
        return undefined;
    }
}

/**
 * Sanitizes command strings.
 * If privacyMode is true, strips all arguments and reveals only the base command/executable.
 * If privacyMode is false or omitted, masks sensitive keys, tokens, passwords, and secrets.
 */
export function sanitizeCommand(command: string, privacyMode: boolean = false): string {
    if (!command || typeof command !== "string") {
        return "";
    }

    if (privacyMode) {
        const trimmed = command.trim();
        if (!trimmed) {
            return "";
        }

        let firstToken = "";
        if (trimmed.startsWith('"')) {
            const endIdx = trimmed.indexOf('"', 1);
            firstToken = endIdx !== -1 ? trimmed.slice(1, endIdx) : trimmed.slice(1);
        } else if (trimmed.startsWith("'")) {
            const endIdx = trimmed.indexOf("'", 1);
            firstToken = endIdx !== -1 ? trimmed.slice(1, endIdx) : trimmed.slice(1);
        } else {
            firstToken = trimmed.split(/\s+/)[0];
        }

        const base = path.basename(firstToken.replace(/\\/g, "/"));
        return base.replace(/\.(exe|cmd|bat)$/i, "") || firstToken;
    }

    let sanitized = command;

    // Mask credentials in inline URLs (handles both token@ and user:pass@)
    sanitized = sanitized.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1");

    // Mask key=value or key:value secrets (supporting quoted strings with spaces)
    sanitized = sanitized.replace(
        /(\b(?:token|password|pass|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s;&|]+)/gi,
        "$1***"
    );

    // Mask CLI flags like --password secret or --token=secret (supporting quoted strings with spaces)
    sanitized = sanitized.replace(
        /(^|\s)(--token|--password|--secret|--api[_-]?key)(\s+|=\s*)('[^']*'|"[^"]*"|[^\s;&|]+)/gi,
        "$1$2$3***"
    );

    // Mask Bearer tokens
    sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]+/gi, "$1***");

    // Mask common raw token patterns
    sanitized = sanitized.replace(/\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, "***");
    sanitized = sanitized.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "***");

    return sanitized;
}

/**
 * Maps tool invocations and arguments to concise, user-friendly activity descriptions for Discord Rich Presence.
 */
export function mapToolToAction(
    toolName: string,
    args?: Record<string, unknown>,
    privacyMode: boolean = false
): string {
    if (!toolName) {
        return "Executing tool";
    }

    const getFilePath = (): string | undefined => {
        const raw = args?.Path ?? args?.path ?? args?.filePath ?? args?.file_path;
        if (typeof raw === "string" && raw.trim().length > 0) {
            return path.basename(raw.trim().replace(/\\/g, "/"));
        }
        return undefined;
    };

    switch (toolName) {
        case "read_file": {
            const file = getFilePath();
            return file ? `Reading ${file}` : "Reading file";
        }

        case "write_file":
        case "edit_file": {
            const file = getFilePath();
            return file ? `Editing ${file}` : "Editing file";
        }

        case "run_command": {
            if (privacyMode) {
                if (args?.CommandLine && typeof args.CommandLine === "string" && args.CommandLine.trim().length > 0) {
                    const cmd = sanitizeCommand(args.CommandLine, true);
                    return cmd ? `Running: ${cmd}` : "Running command";
                }
                return "Running command";
            }

            if (args?.toolSummary && typeof args.toolSummary === "string" && args.toolSummary.trim().length > 0) {
                const summary = sanitizeCommand(args.toolSummary.trim(), false);
                return `Running: ${summary}`;
            }

            if (args?.CommandLine && typeof args.CommandLine === "string" && args.CommandLine.trim().length > 0) {
                const cmd = sanitizeCommand(args.CommandLine, false);
                return cmd ? `Running: ${cmd}` : "Running command";
            }

            return "Running command";
        }

        case "invoke_subagent":
            return "Dispatching Subagent";

        case "search_web":
            return "Searching web documentation";

        case "define_subagent":
            return "Defining Subagent";

        case "manage_subagents":
            return "Managing Subagents";

        case "manage_task":
            return "Managing background tasks";

        case "schedule":
            return "Scheduling task";

        case "ask_question":
            return "Asking question";

        case "list_plugin_accounts":
            return "Checking plugin accounts";

        case "search_marketplace":
            return "Browsing plugin marketplace";

        default:
            return `Executing ${toolName}`;
    }
}

/**
 * Truncates text fields to Discord Rich Presence character limits cleanly by Unicode codepoints.
 * Enforces a minimum length of 2 characters (returns undefined if trimmed length < 2).
 * Appends '...' when truncating strings that exceed maxLength.
 */
export function truncateRpcText(value: string | undefined, maxLength: number): string | undefined {
    if (!value || typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    const chars = Array.from(trimmed);

    if (chars.length < 2) {
        return undefined;
    }

    if (chars.length <= maxLength) {
        return trimmed;
    }

    if (maxLength < 3) {
        return chars.slice(0, maxLength).join("");
    }

    return chars.slice(0, maxLength - 3).join("") + "...";
}

/**
 * Validates a Discord RPC button URL: must be valid http: or https: scheme and <= 512 characters.
 */
export function validateRpcButtonUrl(rawUrl: string): string | undefined {
    if (!rawUrl || typeof rawUrl !== "string") {
        return undefined;
    }

    if (rawUrl.length > 512) {
        return undefined;
    }

    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return undefined;
        }
        return rawUrl;
    } catch {
        return undefined;
    }
}

