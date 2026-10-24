# Image inputs

`ChatMessage.images` and `agent.chat(text, { images })` accept inline PNG, JPEG,
and WebP inputs. Each image contains `mimeType` and raw base64 `data`, without a
data URL prefix. The text may be empty for an image-only turn.

```ts
await agent.chat('Describe this photo.', {
  images: [{ mimeType: 'image/png', data: pngBase64 }],
});
```

The message history retains images for subsequent turns and `loadHistory()`.
OpenAI Responses uses `input_image`, Chat Completions uses `image_url`, Gemini
uses `inlineData`, and Ollama receives an `images` array of raw base64 strings.
The selected model must support vision; provider validation errors are surfaced
normally. Images are never fetched from URLs or read from filesystem paths by
these adapters.

The application owns file selection, format validation, upload limits, and
persistence. Local context estimation reserves 1,536 tokens per image as a
heuristic rather than counting base64 as text. Actual image token usage depends
on the provider, model, and resolution; completed request meters use the
provider-reported usage.
