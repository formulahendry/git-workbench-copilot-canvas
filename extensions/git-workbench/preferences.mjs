export const preferenceLimits = Object.freeze({ text: 512, remote: 1024, expanded: 256, expansionKey: 1024 });

export function defaultPreferences() {
    return { tab: "changes", diffMode: "unified", autoRefresh: false, remote: "", fileSearch: "", changeFilter: "", expanded: {} };
}

function requirePreference(condition, field) {
    if (condition) return;
    const error = new Error(`Invalid UI preference: ${field}.`);
    error.code = "invalid_preferences";
    throw error;
}

function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function boundedText(value, max) {
    return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

// Only explicit UI fields cross the persistence boundary, never refs, drafts or capabilities.
export function validatePreferences(value) {
    requirePreference(record(value), "object");
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        switch (key) {
            case "tab": requirePreference(["changes", "history", "files"].includes(entry), key); break;
            case "diffMode": requirePreference(["unified", "split", "raw"].includes(entry), key); break;
            case "autoRefresh": requirePreference(typeof entry === "boolean", key); break;
            case "remote": requirePreference(boundedText(entry, preferenceLimits.remote), key); break;
            case "fileSearch":
            case "changeFilter": requirePreference(boundedText(entry, preferenceLimits.text), key); break;
            case "expanded": {
                requirePreference(record(entry) && Object.keys(entry).length <= preferenceLimits.expanded, key);
                const expanded = {};
                for (const [name, open] of Object.entries(entry)) {
                    requirePreference(name.length > 0 && boundedText(name, preferenceLimits.expansionKey) &&
                        !["__proto__", "constructor", "prototype"].includes(name) && typeof open === "boolean", "expanded entry");
                    expanded[name] = open;
                }
                result.expanded = expanded;
                continue;
            }
            default: requirePreference(false, key);
        }
        result[key] = entry;
    }
    return result;
}
