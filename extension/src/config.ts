/** Not imported by the content script — content scripts cannot be ES modules. */
export interface Config {
  serverUrl: string;
  token: string;
  targetLanguage: string;
}

export const DEFAULTS: Config = {
  serverUrl: "http://127.0.0.1:47821",
  token: "",
  targetLanguage: "English",
};

export async function loadConfig(): Promise<Config> {
  const stored = (await chrome.storage.sync.get(DEFAULTS)) as Config;
  return { ...DEFAULTS, ...stored };
}
