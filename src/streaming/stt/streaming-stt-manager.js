import { StreamingSttClient } from './streaming-stt-client.js';

/**
 * Manages one StreamingSttClient per SmartPing streamSid.
 */
export class StreamingSttManager {
  constructor(options = {}) {
    this.options = options;
    this.clients = new Map();
    this.ClientClass = options.ClientClass || StreamingSttClient;
  }

  async startSession({
    streamSid,
    callSid = null,
    language = 'en',
    onTranscript = null,
    onEvent = null,
    onError = null,
  } = {}) {
    if (!streamSid) throw new Error('streamSid required');
    await this.stopSession(streamSid);
    const client = new this.ClientClass({
      url: this.options.url,
      token: this.options.token || '',
      connectTimeoutMs: this.options.connectTimeoutMs,
      transcriptTimeoutMs: this.options.transcriptTimeoutMs,
      maxPendingAudioBytes: this.options.maxPendingAudioBytes,
      WebSocketImpl: this.options.WebSocketImpl,
      streamSid,
      callSid,
      language,
      onTranscript,
      onEvent,
      onError,
    });
    this.clients.set(streamSid, client);
    try {
      await client.connect();
    } catch (err) {
      this.clients.delete(streamSid);
      await client.stop().catch(() => {});
      throw err;
    }
    return client;
  }

  pushAudio(streamSid, audio) {
    const client = this.clients.get(streamSid);
    if (!client) return false;
    client.pushAudio(audio);
    return true;
  }

  async stopSession(streamSid) {
    const client = this.clients.get(streamSid);
    if (!client) return;
    this.clients.delete(streamSid);
    await client.stop();
  }

  async closeAll() {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.stopSession(id)));
  }

  get(streamSid) {
    return this.clients.get(streamSid) ?? null;
  }

  size() {
    return this.clients.size;
  }
}
