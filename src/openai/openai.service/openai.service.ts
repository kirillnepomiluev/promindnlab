import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
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

// Описание возвращаемого файла от OpenAI
export interface OpenAiFile {
  filename: string;
  buffer: Buffer;
}

// Структура ответа ассистента: текст + возможные файлы
export interface OpenAiAnswer {
  text: string;
  files: OpenAiFile[];
}

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
          .output(outPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
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

  // Разбор сообщения ассистента: извлекаем текст и скачиваем приложенные файлы
  private async buildAnswer(assistantMessage: any): Promise<OpenAiAnswer> {
    let text = '';
    const fileIds = new Set<string>();

    // Собираем текстовые блоки и ищем ссылки на файлы в аннотациях
    for (const part of assistantMessage.content || []) {
      if (part.type === 'text') {
        text += (text ? '\n' : '') + part.text.value;
        part.text.annotations?.forEach((ann: any) => {
          if (ann.type === 'file_path' && ann.file_path?.file_id) {
            fileIds.add(ann.file_path.file_id);
          }
        });
      } else if (part.type === 'image_file' && part.image_file?.file_id) {
        fileIds.add(part.image_file.file_id);
      }
    }

    // Также учитываем явно прикреплённые файлы
    assistantMessage.attachments?.forEach((att: any) => {
      if (att.file_id) fileIds.add(att.file_id);
    });

    const files: OpenAiFile[] = [];
    for (const id of fileIds) {
      try {
        // Получаем метаданные файла для имени
        const meta = await this.openAi.files.retrieve(id);
        // Скачиваем содержимое файла
        const res = await this.openAi.files.content(id);
        const buffer = Buffer.from(await res.arrayBuffer());
        files.push({ filename: meta.filename ?? id, buffer });
      } catch (err) {
        this.logger.error(`Не удалось скачать файл ${id}`, err as Error);
      }
    }

    return { text, files };
  }

  // ID ассистента для оптимизации промтов видео
  private readonly VIDEO_PROMPT_OPTIMIZER_ASSISTANT_ID = 'asst_qtXWMEt5EWtSUXTgPEQDqYVM';

  // Основной текстовый чат с ассистентом
  async chat(content: string, userId: number): Promise<OpenAiAnswer> {
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
        const messages = await this.openAi.beta.threads.messages.list(
          response.thread_id,
        );
        const assistantMessage = messages.data[0];
        return await this.buildAnswer(assistantMessage);
      } else {
        console.log(response.status);
      }
    } catch (error) {
      console.error(error);
      console.log(error);
    }
    return {
      text: '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже',
      files: [],
    };
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
  async generateImageFromPhoto(
    image: Buffer,
    prompt: string,
  ): Promise<string | Buffer | null> {
    try {
      // изображение конвертируется в PNG и уменьшатся до < 4 МБ
      const prepared = await this.prepareImage(image);
      const file = await toFile(prepared, 'image.png', { type: 'image/png' });
      // Используем ту же модель, что и при обычной генерации,
      // передавая текст пользователя в качестве промта
      const { data } = await this.openAi.images.edit({
        image: file,
        prompt,
        model: 'gpt-image-1',
        quality: 'low',
        n: 1,
        size: '1024x1024',
      });
      if (!data || data.length === 0) {
        this.logger.error('Image.edit вернул пустой data', data);
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
      this.logger.error('Ошибка при редактировании изображения', err);
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
  ): Promise<OpenAiAnswer> {
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
      const fileObj = await toFile(prepared, 'image.png', { type: 'image/png' });
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
        return await this.buildAnswer(assistantMessage);
      }
      return {
        text: '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже',
        files: [],
      };
    } catch (error) {
      this.logger.error('Ошибка при отправке сообщения с картинкой', error);
      return {
        text: '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже',
        files: [],
      };
    }
  }

  /**
   * Оптимизирует промт для генерации видео через специального ассистента
   * @param prompt - исходный промт пользователя
   * @returns Promise<string> - оптимизированный промт
   */
  async optimizeVideoPrompt(prompt: string): Promise<string> {
    try {
      this.logger.log(`Оптимизирую промт для видео: ${prompt}`);
      
      // Создаем новый тред для оптимизации промта
      const thread = await this.openAi.beta.threads.create();
      
      // Добавляем сообщение пользователя в тред
      await this.openAi.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: `Оптимизируй этот промт для генерации видео, сделав его более детальным и подходящим для AI генерации видео: "${prompt}"`,
      });

      // Генерируем ответ ассистента-оптимизатора
      const response = await this.openAi.beta.threads.runs.createAndPoll(
        thread.id,
        {
          assistant_id: this.VIDEO_PROMPT_OPTIMIZER_ASSISTANT_ID,
        },
      );

      if (response.status === 'completed') {
        const messages = await this.openAi.beta.threads.messages.list(
          response.thread_id,
        );
        const assistantMessage = messages.data[0];
        const optimizedPrompt = (assistantMessage.content?.[0] as any)?.text?.value || prompt;
        
        this.logger.log(`Промт оптимизирован: ${optimizedPrompt}`);
        return optimizedPrompt;
      } else {
        this.logger.warn(`Ассистент-оптимизатор вернул статус: ${response.status}`);
        return prompt; // Возвращаем исходный промт если что-то пошло не так
      }
    } catch (error) {
      this.logger.error('Ошибка при оптимизации промта для видео', error);
      return prompt; // Возвращаем исходный промт в случае ошибки
    }
  }

  /**
   * Отправляет файл вместе с текстом в ассистента
   * content - текстовое сообщение пользователя
   * fileBuffer - содержимое файла
   * filename - имя файла (нужно для корректной передачи в API)
   */
  async chatWithFile(
    content: string,
    userId: number,
    fileBuffer: Buffer,
    filename: string,
  ): Promise<OpenAiAnswer> {
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
      const fileObj = await toFile(fileBuffer, filename);
      const file = await this.openAi.files.create({
        file: fileObj,
        purpose: 'assistants',
      });

      await this.openAi.beta.threads.messages.create(thread.id, {
        role: 'user',
        content,
        attachments: [
          {
            file_id: file.id,
            tools: [{ type: 'file_search' }],
          },
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
        return await this.buildAnswer(assistantMessage);
      }
      return {
        text: '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже',
        files: [],
      };
    } catch (error) {
      this.logger.error('Ошибка при отправке сообщения с файлом', error);
      return {
        text: '🤖 Не удалось получить ответ от OpenAI. Попробуйте позже',
        files: [],
      };
    }
  }
}
