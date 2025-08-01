import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { TextContentBlock } from 'openai/resources/beta/threads/messages';
import { toFile } from 'openai/uploads';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpeg = require('fluent-ffmpeg');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
import { SessionService } from '../../session/session.service';

@Injectable()
export class OpenAiService {
  private readonly openAi: OpenAI;
  private readonly logger = new Logger(OpenAiService.name);
  private threadMap: Map<number, string> = new Map();

  /**
   * Подготавливает изображение для отправки в OpenAI: конвертирует в PNG,
   * уменьшает размеры до требуемых и гарантирует объём < 4 MB.
   */
  private async prepareImage(image: Buffer): Promise<Buffer> {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `${crypto.randomUUID()}.src`);
    const outPath = path.join(tmpDir, `${crypto.randomUUID()}.png`);
    await fs.writeFile(inputPath, image);

    let size = 1024;
    let result: Buffer = image;
    while (size >= 256) {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-vf',
            `scale=${size}:${size}`,
            '-compression_level',
            '9',
          ])
          .toFormat('png')
          .save(outPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });
      result = await fs.readFile(outPath);
      if (result.length <= 4 * 1024 * 1024) break;
      size = Math.floor(size / 2);
    }

    await Promise.allSettled([fs.unlink(inputPath), fs.unlink(outPath)]);
    return result;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: SessionService,
  ) {
    const rawKey = this.configService.get<string>('OPENAI_API_KEY_PRO');
    if (!rawKey) {
      throw new Error('Не задана переменная окружения OPENAI_API_KEY_PRO');
    }
    this.logger.debug(`Raw OpenAI API key length: ${rawKey.length}`);
    this.logger.debug(
      `API raw key fragment: ${rawKey.slice(0, 5)}...${rawKey.slice(-5)}`,
    );
    // Удаляем BOM и переносы
    const key = rawKey.replace(/\s+/g, '').trim();
    this.logger.debug(
      `API key fragment: ${key.slice(0, 5)}...${key.slice(-5)}`,
    );
    this.logger.debug(`Sanitized OpenAI API key length: ${key.length}`);

    const baseURL =
      this.configService.get<string>('OPENAI_BASE_URL_PRO')?.trim() ||
      'https://chat.neurolabtg.ru/v1';

    this.openAi = new OpenAI({
      apiKey: key,
      baseURL,
    });
  }
  async waitForRunCompletion(threadId: string, runId: string) {
    let runStatus = 'in_progress';

    while (runStatus === 'in_progress' || runStatus === 'queued') {
      console.log(`Ожидание завершения run ${runId}...`);
      await new Promise((res) => setTimeout(res, 3000)); // Ждём 3 секунды перед повторной проверкой

      const run = await this.openAi.beta.threads.runs.retrieve(threadId, runId);
      runStatus = run.status;
    }

    console.log(`Run ${runId} завершен со статусом: ${runStatus}`);
  }

  async chat(content: string, userId: number) {
    let threadId = await this.sessionService.getSessionId(userId);
    if (threadId) {
      this.threadMap.set(userId, threadId);
    }
    let thread: { id: string };
    const assistantId = 'asst_naDxPxcSCe4YgEW3S7fXf4wd';
    try {
      if (!threadId) {
        // Создаем новый тред, если не существует
        thread = await this.openAi.beta.threads.create();

        threadId = thread.id;
        this.threadMap.set(userId, threadId);
        await this.sessionService.setSessionId(userId, threadId);
      } else {
        // Если тред уже есть, просто получаем его ID
        thread = { id: threadId };
      }
      // === Проверяем, есть ли активный run ===
      const runs = await this.openAi.beta.threads.runs.list(threadId);
      const activeRun = runs.data.find(
        (run) => run.status === 'in_progress' || run.status === 'queued',
      );

      if (activeRun) {
        console.log(
          `Активный run уже выполняется для thread ${threadId}. Ждем завершения...`,
        );
        await this.waitForRunCompletion(threadId, activeRun.id);
      }

      // Добавляем сообщение пользователя в тред
      await this.openAi.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: content,
      });

      // Генерируем ответ ассистента по треду
      const response = await this.openAi.beta.threads.runs.createAndPoll(
        thread.id,
        {
          assistant_id: assistantId,
        },
      );
      if (response.status === 'completed') {
        // const tokensUsed = response.usage?.total_tokens ?? 0;

        const messages = await this.openAi.beta.threads.messages.list(
          response.thread_id,
        );
        // for (const message of messages.data.reverse()) {
        //   //console.log(`${message.role} > ${message.content[0].text.value}`);
        // }

        const assistantMessage = messages.data[0];
        if (assistantMessage.content[0].type == 'text') {
          const answer: TextContentBlock = assistantMessage.content[0];

          return answer.text.value;
        }
      } else {
        console.log(response.status);
      }

      // Предполагается, что response содержит массив messages,
      // где последний элемент - ответ ассистента
    } catch (error) {
      console.error(error);
      console.log(error);
      return '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже';
    }
  }

  async generateImage(prompt: string): Promise<string | Buffer | null> {
    try {
      const { data } = await this.openAi.images.generate({
        model: 'gpt-image-1',
        prompt,
        quality: 'low',
        n: 1,
        size: '1024x1024',
      });
      if (!data || data.length === 0) {
        this.logger.error('Image.generate вернул пустой data', data);
        return null;
      }
      const img = data[0];
      // Основной случай: ответ в формате base64-JSON
      if ('b64_json' in img && img.b64_json) {
        return Buffer.from(img.b64_json, 'base64');
      }
      // На случай других моделей: возвращаем URL
      if ('url' in img && img.url) {
        return img.url;
      }
      this.logger.error('Image data не содержит ни b64_json, ни url', img);
      return null;
    } catch (err: any) {
      this.logger.error('Ошибка при генерации изображения', err);
      return null;
    }
  }

  /**
   * Генерирует изображение на основе присланной пользователем картинки
   * с помощью endpoint'a createVariation
   */
  async generateImageFromPhoto(image: Buffer): Promise<string | Buffer | null> {
    try {
      const prepared = await this.prepareImage(image);
      const file = await toFile(prepared, 'image.png');
      const { data } = await this.openAi.images.createVariation({
        image: file,
        model: 'dall-e-2',
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      });
      if (!data || data.length === 0) {
        this.logger.error('Image.createVariation вернул пустой data', data);
        return null;
      }
      const img = data[0];
      if ('b64_json' in img && img.b64_json) {
        return Buffer.from(img.b64_json, 'base64');
      }
      if ('url' in img && img.url) {
        return img.url;
      }
      this.logger.error('Image data не содержит ни b64_json, ни url', img);
      return null;
    } catch (err: any) {
      this.logger.error('Ошибка при вариации изображения', err);
      return null;
    }
  }

  /**
   * Отправляет в ассистента сообщение вместе с картинкой
   */
  async chatWithImage(
    content: string,
    userId: number,
    image: Buffer,
  ): Promise<string> {
    let threadId = await this.sessionService.getSessionId(userId);
    if (threadId) {
      this.threadMap.set(userId, threadId);
    }
    let thread: { id: string };
    const assistantId = 'asst_naDxPxcSCe4YgEW3S7fXf4wd';
    try {
      if (!threadId) {
        thread = await this.openAi.beta.threads.create();
        threadId = thread.id;
        this.threadMap.set(userId, threadId);
        await this.sessionService.setSessionId(userId, threadId);
      } else {
        thread = { id: threadId };
      }

      const runs = await this.openAi.beta.threads.runs.list(threadId);
      const activeRun = runs.data.find(
        (run) => run.status === 'in_progress' || run.status === 'queued',
      );

      if (activeRun) {
        await this.waitForRunCompletion(threadId, activeRun.id);
      }

      // загружаем файл для ассистента
      const prepared = await this.prepareImage(image);
      const fileObj = await toFile(prepared, 'image.png');
      const file = await this.openAi.files.create({
        file: fileObj,
        purpose: 'assistants',
      });

      await this.openAi.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: [
          { type: 'text', text: content },
          { type: 'image_file', image_file: { file_id: file.id } },
        ],
      });

      const response = await this.openAi.beta.threads.runs.createAndPoll(
        thread.id,
        {
          assistant_id: assistantId,
        },
      );
      if (response.status === 'completed') {
        const messages = await this.openAi.beta.threads.messages.list(
          response.thread_id,
        );
        const assistantMessage = messages.data[0];
        if (assistantMessage.content[0].type == 'text') {
          const answer: TextContentBlock = assistantMessage.content[0];
          return answer.text.value;
        }
      }
      return '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже';
    } catch (error) {
      this.logger.error('Ошибка при отправке сообщения с картинкой', error);
      return '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже';
    }
  }
}
