// The AI providers a Free user can bring a key for. Anthropic has its own
// API; every other one speaks OpenAI's chat completions at `url`. Loaded
// by background.js (importScripts) and options.html. Chrome access to
// `origin` is asked for on Save; the manifest's optional https://*/*
// covers every one, so a new provider needs only a row here.
globalThis.oojProviders = {
  anthropic: { label: 'Anthropic', url: 'https://api.anthropic.com/v1/messages', origin: 'https://api.anthropic.com/*', model: 'claude-haiku-5-5' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', origin: 'https://api.openai.com/*' },
  google: { label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', origin: 'https://generativelanguage.googleapis.com/*' },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', origin: 'https://api.mistral.ai/*' },
  xai: { label: 'xAI (Grok)', url: 'https://api.x.ai/v1/chat/completions', origin: 'https://api.x.ai/*' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', origin: 'https://api.deepseek.com/*' },
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', origin: 'https://api.groq.com/*' },
  together: { label: 'Together AI', url: 'https://api.together.xyz/v1/chat/completions', origin: 'https://api.together.xyz/*' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', origin: 'https://openrouter.ai/*' },
};
