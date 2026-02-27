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
  private readonly fallbackOpenAi: OpenAI;
  private readonly logger = new Logger(OpenAiService.name);
  private threadMap: Map<number, string> = new Map();

  // Система блокировки тредов - Map для отслеживания активных запросов по threadId
  private activeThreads: Map<string, Promise<any>> = new Map();
  
  // Флаг для отслеживания доступности основного API
  private isMainApiAvailable: boolean = true;
  private lastMainApiCheck: number = 0;
  private readonly API_CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут
  
  // Таймер для очистки устаревших тредов
  private readonly THREAD_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 минут
  private lastThreadCleanup: number = 0;

  // Поддерживаемые OpenAI API расширения файлов
  private readonly SUPPORTED_EXTENSIONS = [
    'c',
    'cpp',
    'css',
    'csv',
    'doc',
    'docx',
    'gif',
    'go',
    'html',
    'java',
    'jpeg',
    'jpg',
    'js',
    'json',
    'md',
    'pdf',
    'php',
    'pkl',
    'png',
    'pptx',
    'py',
    'rb',
    'tar',
    'tex',
    'ts',
    'txt',
    'webp',
    'xlsx',
    'xml',
    'zip',
  ];

  /**
   * Проверяет доступность основного API
   */
  private async checkMainApiAvailability(): Promise<boolean> {
    const now = Date.now();
    
    // Проверяем не чаще чем раз в 5 минут
    if (now - this.lastMainApiCheck < this.API_CHECK_INTERVAL) {
      return this.isMainApiAvailable;
    }
    
    try {
      this.lastMainApiCheck = now;
      // Простой тест API - получаем список моделей
      await this.openAi.models.list();
      this.isMainApiAvailable = true;
      this.logger.log('Основной сервера API доступен');
      return true;
    } catch (error) {
      this.isMainApiAvailable = false;
      this.logger.warn('Основной сервера API недоступен, используем fallback', error);
      return false;
    }
  }

  /**
   * Получает активный OpenAI клиент (основной или fallback)
   */
  private async getActiveOpenAiClient(): Promise<OpenAI> {
    if (await this.checkMainApiAvailability()) {
      return this.openAi;
    }
    return this.fallbackOpenAi;
  }

  /**
   * Выполняет операцию с retry логикой
   */
  private async executeWithRetry<T>(
    operation: (client: OpenAI) => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = await this.getActiveOpenAiClient();
        return await operation(client);
      } catch (error: any) {
        lastError = error;
        
        // Если это ошибка 502, сразу переключаемся на fallback
        if (error.message?.includes('502') || error.status === 502) {
          this.logger.warn(`Получена ошибка 502, переключаемся на fallback API (попытка ${attempt}/${maxRetries})`);
          this.isMainApiAvailable = false;
          continue;
        }
        
        // Если это ошибка истекшего векторного хранилища, создаем новый тред
        if (error.message?.includes('Vector store') && error.message?.includes('is expired')) {
          this.logger.warn(`Векторное хранилище истекло, создаем новый тред (попытка ${attempt}/${maxRetries})`);
          // Сбрасываем threadId для пользователя, чтобы создать новый тред
          // Это будет обработано в вызывающем методе
          throw new Error('VECTOR_STORE_EXPIRED');
        }
        
        // Для других ошибок ждем перед повторной попыткой
        if (attempt < maxRetries) {
          this.logger.warn(`Попытка ${attempt} не удалась, повторяем через ${delayMs}ms`, error);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          delayMs *= 2; // Экспоненциальная задержка
        }
      }
    }
    
    throw lastError;
  }

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
          .outputOptions(['-vf', `scale=${size}:${size}`, '-compression_level', '9'])
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
    this.logger.debug(`API raw key fragment: ${rawKey.slice(0, 5)}...${rawKey.slice(-5)}`);
    // Удаляем BOM и переносы
    const key = rawKey.replace(/\s+/g, '').trim();
    this.logger.debug(`API key fragment: ${key.slice(0, 5)}...${key.slice(-5)}`);
    this.logger.debug(`Sanitized OpenAI API key length: ${key.length}`);

    const baseURL = this.configService.get<string>('OPENAI_BASE_URL_PRO')?.trim() || 'https://chat.neurolabtg.ru/v1';

    this.openAi = new OpenAI({
      apiKey: key,
      baseURL,
    });

    // Создаем fallback клиент для случаев, когда основной API недоступен
    this.fallbackOpenAi = new OpenAI({
      apiKey: key, // Используем тот же ключ для fallback
      baseURL: 'https://api.openai.com/v1', // Fallback на официальный OpenAI API
    });
  }

  /**
   * Проверяет, активен ли тред (выполняется ли в нем запрос)
   */
  private isThreadActive(threadId: string): boolean {
    return this.activeThreads.has(threadId);
  }

  /**
   * Блокирует тред для выполнения запроса
   */
  private async lockThread<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    if (this.isThreadActive(threadId)) {
      throw new Error('Тред уже занят другим запросом. Пожалуйста, дождитесь завершения предыдущего запроса.');
    }

    const promise = operation();
    this.activeThreads.set(threadId, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.activeThreads.delete(threadId);
    }
  }

  /**
   * Проверяет активные runs в треде и ждет их завершения
   */
  private async checkAndWaitForActiveRuns(threadId: string): Promise<void> {
    const client = await this.getActiveOpenAiClient();
    const runs = await client.beta.threads.runs.list(threadId);
    const activeRun = runs.data.find(
      (run) => run.status === 'in_progress' || run.status === 'queued'
    );

    if (activeRun) {
      this.logger.log(`Активный run уже выполняется для thread ${threadId}. Ждем завершения...`);
      await this.waitForRunCompletion(threadId, activeRun.id);
    }
  }

  async waitForRunCompletion(threadId: string, runId: string) {
    let runStatus = 'in_progress';

    while (runStatus === 'in_progress' || runStatus === 'queued') {
      console.log(`Ожидание завершения run ${runId}...`);
      await new Promise((res) => setTimeout(res, 3000)); // Ждём 3 секунды перед повторной проверкой

      const client = await this.getActiveOpenAiClient();
      const run = await client.beta.threads.runs.retrieve(threadId, runId);
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
        // Получаем активный клиент для работы с файлами
        const client = await this.getActiveOpenAiClient();
        // Получаем метаданные файла для имени
        const meta = await client.files.retrieve(id);
        // Скачиваем содержимое файла
        const res = await client.files.content(id);
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
    // Проверяем и очищаем устаревшие треды
    await this.cleanupExpiredThreads();
    
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

      // Используем систему блокировки тредов
      return await this.lockThread(threadId, async () => {
        // Проверяем активные runs в треде
        await this.checkAndWaitForActiveRuns(threadId);

        return await this.executeWithRetry(async (client) => {
          // Добавляем сообщение пользователя в тред
          await client.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: content,
          });

          // Генерируем ответ ассистента по треду
          const response = await client.beta.threads.runs.createAndPoll(
            thread.id,
            {
              assistant_id: assistantId,
            },
          );
          
          if (response.status === 'completed') {
            const messages = await client.beta.threads.messages.list(
              response.thread_id,
            );
            const assistantMessage = messages.data[0];
            return await this.buildAnswer(assistantMessage);
          } else {
            const errInfo = (response as { last_error?: { code?: string; message?: string } }).last_error;
            const detail = errInfo ? ` [${errInfo.code}: ${errInfo.message}]` : '';
            this.logger.warn(`Run завершился со статусом: ${response.status}${detail}`);
            throw new Error(`Run завершился со статусом: ${response.status}${detail}`);
          }
        });
      });
    } catch (error) {
      // Если это ошибка истекшего векторного хранилища, создаем новый тред
      if (error instanceof Error && error.message === 'VECTOR_STORE_EXPIRED') {
        this.logger.log('Создаем новый тред из-за истекшего векторного хранилища');
        // Удаляем старый тред из сессии и создаем новый
        await this.sessionService.setSessionId(userId, null);
        this.threadMap.delete(userId);
        
        // Рекурсивно вызываем метод с новым тредом
        return await this.chat(content, userId);
      }
      
      this.logger.error('Ошибка в чате с ассистентом', error);

      // Если это ошибка блокировки треда, возвращаем специальное сообщение
      if (error instanceof Error && error.message.includes('Тред уже занят')) {
        return {
          text: '⏳ Тред уже занят другим запросом. Пожалуйста, дождитесь завершения предыдущего запроса.',
          files: [],
        };
      }

      return {
        text: '🤖 Не удалось получить ответ от сервера. Попробуйте позже',
        files: [],
      };
    }
  }

  async generateImage(prompt: string): Promise<string | Buffer | null> {
    try {
      return await this.executeWithRetry(async (client) => {
        const { data } = await client.images.generate({
          model: 'gpt-image-1',
          prompt,
          quality: 'high',
          n: 1,
          size: '1024x1024',
          moderation: 'low',
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
      });
    } catch (err: any) {
      this.logger.error('Ошибка при генерации изображения', err);
      return null;
    }
  }

  /**
   * Генерирует изображение на основе присланной пользователем картинки
   * с помощью endpoint'a createVariation
   */
  async generateImageFromPhoto(image: Buffer, prompt: string): Promise<string | Buffer | null> {
    try {
      // изображение конвертируется в PNG и уменьшатся до < 4 МБ
      const prepared = await this.prepareImage(image);
      const file = await toFile(prepared, 'image.png', { type: 'image/png' });
      // Используем ту же модель, что и при обычной генерации,
      // передавая текст пользователя в качестве промта
      return await this.executeWithRetry(async (client) => {
        const { data } = await client.images.edit({
          image: file,
          prompt,
          model: 'gpt-image-1',
          quality: 'high',
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
      });
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
    // Проверяем и очищаем устаревшие треды
    await this.cleanupExpiredThreads();
    
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

      // Используем систему блокировки тредов
      return await this.lockThread(threadId, async () => {
        // Проверяем активные runs в треде
        await this.checkAndWaitForActiveRuns(threadId);

        return await this.executeWithRetry(async (client) => {
          // загружаем файл для ассистента
          const prepared = await this.prepareImage(image);
          const fileObj = await toFile(prepared, 'image.png', { type: 'image/png' });
          const file = await client.files.create({
            file: fileObj,
            purpose: 'assistants',
          });

          await client.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: [
              { type: 'text', text: content },
              { type: 'image_file', image_file: { file_id: file.id } },
            ],
          });

          const response = await client.beta.threads.runs.createAndPoll(
            thread.id,
            {
              assistant_id: assistantId,
            },
          );
          
          if (response.status === 'completed') {
            const messages = await client.beta.threads.messages.list(
              response.thread_id,
            );
            const assistantMessage = messages.data[0];
            return await this.buildAnswer(assistantMessage);
          } else {
            const errInfo = (response as { last_error?: { code?: string; message?: string } }).last_error;
            const detail = errInfo ? ` [${errInfo.code}: ${errInfo.message}]` : '';
            this.logger.warn(`Run завершился со статусом: ${response.status}${detail}`);
            throw new Error(`Run завершился со статусом: ${response.status}${detail}`);
          }
        });
      });
    } catch (error) {
      // Если это ошибка истекшего векторного хранилища, создаем новый тред
      if (error instanceof Error && error.message === 'VECTOR_STORE_EXPIRED') {
        this.logger.log('Создаем новый тред из-за истекшего векторного хранилища');
        // Удаляем старый тред из сессии и создаем новый
        await this.sessionService.setSessionId(userId, null);
        this.threadMap.delete(userId);
        
        // Рекурсивно вызываем метод с новым тредом
        return await this.chatWithImage(content, userId, image);
      }
      
      this.logger.error('Ошибка при отправке сообщения с картинкой', error);

      // Если это ошибка блокировки треда, возвращаем специальное сообщение
      if (error instanceof Error && error.message.includes('Тред уже занят')) {
        return {
          text: '⏳ Тред уже занят другим запросом. Пожалуйста, дождитесь завершения предыдущего запроса.',
          files: [],
        };
      }

      return {
        text: '🤖 Не удалось получить ответ от сервера ИИ. Попробуйте позже',
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
      
      return await this.executeWithRetry(async (client) => {
        // Создаем новый тред для оптимизации промта
        const thread = await client.beta.threads.create();
        
        // Добавляем сообщение пользователя в тред
        await client.beta.threads.messages.create(thread.id, {
          role: 'user',
          content: `Оптимизируй этот промт для генерации видео, сделав его более детальным и подходящим для AI генерации видео: "${prompt}"`,
        });

        // Генерируем ответ ассистента-оптимизатора
        const response = await client.beta.threads.runs.createAndPoll(
          thread.id,
          {
            assistant_id: this.VIDEO_PROMPT_OPTIMIZER_ASSISTANT_ID,
          },
        );

        if (response.status === 'completed') {
          const messages = await client.beta.threads.messages.list(
            response.thread_id,
          );
          const assistantMessage = messages.data[0];
          const optimizedPrompt = (assistantMessage.content?.[0] as any)?.text?.value || prompt;
          
          this.logger.log(`Промт оптимизирован: ${optimizedPrompt}`);
          return optimizedPrompt;
        } else {
          const errInfo = (response as { last_error?: { code?: string; message?: string } }).last_error;
          const detail = errInfo ? ` [${errInfo.code}: ${errInfo.message}]` : '';
          this.logger.warn(`Ассистент-оптимизатор вернул статус: ${response.status}${detail}`);
          return prompt; // Возвращаем исходный промт если что-то пошло не так
        }
      });
    } catch (error) {
      this.logger.error('Ошибка при оптимизации промта для видео', error);
      return prompt; // Возвращаем исходный промт в случае ошибки
    }
  }

  /**
   * Нормализует имя файла, приводя расширение к нижнему регистру
   * для совместимости с OpenAI API
   * 
   * Примеры:
   * - "document.DOCX" -> "document.docx"
   * - "image.JPG" -> "image.jpg"
   * - "file.PDF" -> "file.pdf"
   * - "text.txt" -> "text.txt" (не изменяется)
   * - "noextension" -> "noextension" (не изменяется)
   */
  private normalizeFilename(filename: string): string {
    if (!filename || !filename.includes('.')) {
      return filename;
    }
    
    const lastDotIndex = filename.lastIndexOf('.');
    const name = filename.substring(0, lastDotIndex);
    const extension = filename.substring(lastDotIndex + 1).toLowerCase();
    
    const normalizedFilename = `${name}.${extension}`;
    
    // Проверяем, поддерживается ли расширение
    if (!this.SUPPORTED_EXTENSIONS.includes(extension)) {
      this.logger.warn(
        `Неподдерживаемое расширение файла: "${extension}" для файла "${filename}". ` +
        `Поддерживаемые форматы: ${this.SUPPORTED_EXTENSIONS.join(', ')}`
      );
    }
    
    // Логируем изменение имени файла, если оно изменилось
    if (normalizedFilename !== filename) {
      this.logger.log(`Нормализовано имя файла: "${filename}" -> "${normalizedFilename}"`);
    }
    
    return normalizedFilename;
  }

  /**
   * Чат с файлом через OpenAI API
   * 
   * ИСПРАВЛЕНО: Автоматическая нормализация имен файлов для решения проблемы
   * с расширениями в верхнем регистре (например, .DOCX -> .docx)
   * OpenAI API чувствителен к регистру расширений файлов
   */
  async chatWithFile(
    content: string,
    userId: number,
    fileBuffer: Buffer,
    filename: string,
  ): Promise<OpenAiAnswer> {
    // Нормализуем имя файла
    const normalizedFilename = this.normalizeFilename(filename);
    
    // Проверяем и очищаем устаревшие треды
    await this.cleanupExpiredThreads();
    
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

      // Используем систему блокировки тредов
      return await this.lockThread(threadId, async () => {
        // Проверяем активные runs в треде
        await this.checkAndWaitForActiveRuns(threadId);

        return await this.executeWithRetry(async (client) => {
          // загружаем файл для ассистента
          const fileObj = await toFile(fileBuffer, normalizedFilename);
          const file = await client.files.create({
            file: fileObj,
            purpose: 'assistants',
          });
          const vectorStore = await client.vectorStores.create({
            name: `for tread ${thread.id}`,
            file_ids: [file.id],
          });
          await client.beta.threads.update(thread.id, {
            tool_resources: {
              file_search: {
                vector_store_ids: [vectorStore.id],
              },
            },
          });
          await client.beta.threads.messages.create(thread.id, {
            role: 'user',
            content,
          });

          const response = await client.beta.threads.runs.createAndPoll(
            thread.id,
            {
              assistant_id: assistantId,
            },
          );
          
          if (response.status === 'completed') {
            const messages = await client.beta.threads.messages.list(
              response.thread_id,
            );
            const assistantMessage = messages.data[0];
            return await this.buildAnswer(assistantMessage);
          } else {
            const errInfo = (response as { last_error?: { code?: string; message?: string } }).last_error;
            const detail = errInfo ? ` [${errInfo.code}: ${errInfo.message}]` : '';
            this.logger.warn(`Run завершился со статусом: ${response.status}${detail}`);
            throw new Error(`Run завершился со статусом: ${response.status}${detail}`);
          }
        });
      });
    } catch (error) {
      // Если это ошибка истекшего векторного хранилища, создаем новый тред
      if (error instanceof Error && error.message === 'VECTOR_STORE_EXPIRED') {
        this.logger.log('Создаем новый тред из-за истекшего векторного хранилища');
        // Удаляем старый тред из сессии и создаем новый
        await this.sessionService.setSessionId(userId, null);
        this.threadMap.delete(userId);
        
        // Рекурсивно вызываем метод с новым тредом
        return await this.chatWithFile(content, userId, fileBuffer, filename);
      }
      
      this.logger.error('Ошибка при отправке сообщения с файлом', error);

      // Если это ошибка блокировки треда, возвращаем специальное сообщение
      if (error instanceof Error && error.message.includes('Тред уже занят')) {
        return {
          text: '⏳ Тред уже занят другим запросом. Пожалуйста, дождитесь завершения предыдущего запроса.',
          files: [],
        };
      }

      return {
        text: '🤖 Не удалось получить ответ от сервера. Попробуйте позже',
        files: [],
      };
    }
  }

  /**
   * Получает информацию о статусе активных тредов (для отладки)
   */
  getActiveThreadsStatus(): { threadId: string; isActive: boolean }[] {
    const status: { threadId: string; isActive: boolean }[] = [];

    // Добавляем информацию о треде из threadMap
    for (const [userId, threadId] of this.threadMap.entries()) {
      status.push({
        threadId: `${threadId} (user: ${userId})`,
        isActive: this.isThreadActive(threadId),
      });
    }

    return status;
  }

  /**
   * Получает статус API endpoints
   */
  getApiStatus(): { mainApi: string; fallbackApi: string; isMainApiAvailable: boolean } {
    return {
      mainApi: this.openAi.baseURL || 'https://chat.neurolabtg.ru/v1',
      fallbackApi: this.fallbackOpenAi.baseURL || 'https://api.openai.com/v1',
      isMainApiAvailable: this.isMainApiAvailable
    };
  }

  /**
   * Принудительно проверяет доступность основного API
   */
  async forceCheckMainApi(): Promise<boolean> {
    this.lastMainApiCheck = 0; // Сбрасываем таймер
    return await this.checkMainApiAvailability();
  }

  /**
   * Принудительно обновляет тред пользователя (создает новый)
   * Полезно при проблемах с векторными хранилищами или других ошибках треда
   */
  async forceRefreshThread(userId: number): Promise<void> {
    this.logger.log(`Принудительно обновляю тред для пользователя ${userId}`);
    
    // Удаляем старый тред из сессии
    await this.sessionService.setSessionId(userId, null);
    
    // Удаляем из локального кэша
    this.threadMap.delete(userId);
    
    this.logger.log(`Тред для пользователя ${userId} успешно обновлен`);
  }

  /**
   * Проверяет валидность треда и очищает устаревшие
   */
  private async cleanupExpiredThreads(): Promise<void> {
    const now = Date.now();
    
    // Проверяем не чаще чем раз в 30 минут
    if (now - this.lastThreadCleanup < this.THREAD_CLEANUP_INTERVAL) {
      return;
    }
    
    this.lastThreadCleanup = now;
    this.logger.log('Начинаю очистку устаревших тредов...');
    
    const client = await this.getActiveOpenAiClient();
    const threadsToRemove: number[] = [];
    
    for (const [userId, threadId] of this.threadMap.entries()) {
      try {
        // Проверяем существование треда
        await client.beta.threads.retrieve(threadId);
      } catch (error: any) {
        // Если тред не существует или истек, помечаем для удаления
        if (error.message?.includes('Vector store') && error.message?.includes('is expired') ||
            error.message?.includes('not found') ||
            error.status === 404) {
          this.logger.warn(`Тред ${threadId} для пользователя ${userId} истек или не найден, помечаю для удаления`);
          threadsToRemove.push(userId);
        }
      }
    }
    
    // Удаляем невалидные треды
    for (const userId of threadsToRemove) {
      await this.sessionService.setSessionId(userId, null);
      this.threadMap.delete(userId);
      this.logger.log(`Тред для пользователя ${userId} удален`);
    }
    
    if (threadsToRemove.length > 0) {
      this.logger.log(`Очистка завершена, удалено ${threadsToRemove.length} устаревших тредов`);
    }
  }
}
