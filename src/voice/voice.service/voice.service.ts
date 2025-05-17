/* eslint-disable @typescript-eslint/no-require-imports */
import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import type { Voice as TgVoice } from 'telegraf/typings/core/types/typegram';

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import fetch from 'node-fetch'; // npm i node-fetch@2

// Используем require для Fluent-FFmpeg и FFmpeg-Static
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpeg = require('fluent-ffmpeg');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPath = require('ffmpeg-static');

import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';

// Проверяем путь к бинарю и устанавливаем его
if (!ffmpegPath) {
  throw new Error('ffmpeg-static: не удалось найти бинарь ffmpeg');
}
ffmpeg.setFfmpegPath(ffmpegPath);

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private readonly configService = new ConfigService();
  private readonly client = new OpenAI({
    apiKey: this.configService.get<string>('OPENAI_API_KEY_PRO'),
    baseURL: 'https://chat.neurolabtg.ru/v1',
  });

  constructor(@InjectBot() private readonly bot: Telegraf) {}

  /** 1️⃣  OGG → текст (Whisper) */
  async voiceToText(voice: TgVoice): Promise<string> {
    const oggPath = await this.downloadTelegramFile(voice.file_id);
    const wavPath = await this.convertToWav(oggPath);
    const { text } = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-1',
    });
    await Promise.allSettled([fsp.unlink(oggPath), fsp.unlink(wavPath)]);
    return text;
  }

  /** 2️⃣  текст → голос (TTS-1) */
  async textToSpeech(text: string): Promise<Buffer> {
    const resp = await this.client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: 'alloy',
      response_format: 'opus',
      instructions: `never use ukraine language use English if request is on English or use Russian if request is Russian`,
    });
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Скачивает файл от Telegram и возвращает путь к .ogg */
  private async downloadTelegramFile(fileId: string): Promise<string> {
    const link = await this.bot.telegram.getFileLink(fileId);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error(`TG download error: ${res.statusText}`);
    const tmpDir = os.tmpdir();
    const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.ogg`);
    await fsp.writeFile(tmpPath, await res.buffer());
    return tmpPath;
  }

  /** Конвертирует OGG → WAV (16-bit PCM, 48 kHz) */
  private convertToWav(oggPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const wavPath = oggPath.replace(/\.ogg$/, '.wav');
      ffmpeg(oggPath)
        .setFfmpegPath(ffmpegPath)
        .outputOptions([
          '-ac',
          '1', // mono
          '-ar',
          '48000', // частота 48 кГц
          '-sample_fmt',
          's16', // 16-бит PCM
        ])
        .toFormat('wav')
        .save(wavPath)
        .on('end', () => resolve(wavPath))
        .on('error', (err: Error) => {
          this.logger.error('FFmpeg error', err.message);
          reject(err);
        });
    });
  }
}
