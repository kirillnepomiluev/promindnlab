import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiService } from '../../openai/openai.service/openai.service';
import fetch from 'node-fetch';
import * as jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import * as FormData from 'form-data';
import { Readable } from 'stream';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpeg = require('fluent-ffmpeg');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

export enum VideoProvider {
  KLING = 'kling',
  OPENAI = 'openai',
}

export interface VideoGenerationResponse {
  success: boolean;
  videoUrl?: string;
  error?: string;
}

export interface VideoGenerationOptions {
  onProgress?: (status: string, attempt: number, maxAttempts: number) => void;
  provider?: VideoProvider;
  quality?: 'lite' | 'pro';
  duration?: number; // длительность видео в секундах
  skipOptimization?: boolean; // пропустить оптимизацию промпта
}

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);
  private readonly klingAccessKey: string;
  private readonly klingSecretKey: string;
  private readonly klingApiUrl: string;
  private readonly openai: OpenAI;
  private readonly defaultProvider: VideoProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly openaiService: OpenAiService,
  ) {
    // Конфигурация Kling
    this.klingAccessKey = this.configService.get<string>('KLING_ACCESS_KEY');
    this.klingSecretKey = this.configService.get<string>('KLING_SECRET_KEY');
    this.klingApiUrl = this.configService.get<string>('KLING_API_URL') || 'https://api.klingai.com';

    if (!this.klingAccessKey || !this.klingSecretKey) {
      this.logger.warn('KLING_ACCESS_KEY или KLING_SECRET_KEY не заданы в переменных окружения');
    }

    // Конфигурация OpenAI для видео
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY_PRO');
    const openaiBaseUrl = this.configService.get<string>('OPENAI_BASE_URL_PRO')?.trim() || 'https://api.openai.com/v1';

    if (!openaiKey) {
      this.logger.error('OPENAI_API_KEY_PRO не задан в переменных окружения');
    }

    this.openai = new OpenAI({
      apiKey: openaiKey?.replace(/\s+/g, '').trim(),
      baseURL: openaiBaseUrl,
    });

    // Установка провайдера по умолчанию (OpenAI)
    const configuredProvider = this.configService.get<string>('VIDEO_PROVIDER')?.toLowerCase();
    this.defaultProvider = configuredProvider === 'kling' ? VideoProvider.KLING : VideoProvider.OPENAI;
    this.logger.log(`Провайдер видео по умолчанию: ${this.defaultProvider}`);
  }

  // ==================== Helper Methods ====================

  /**
   * Преобразует duration для OpenAI API
   * OpenAI API поддерживает только значения 4, 8, 12
   * Преобразует 5->4, 10->8, 15->12
   * @param duration - исходная длительность в секундах
   * @returns преобразованная длительность для OpenAI API
   */
  private normalizeDurationForOpenAI(duration?: number): number {
    if (!duration) return 4;
    // OpenAI API поддерживает только 4, 8, 12
    if (duration === 5) return 4;
    if (duration === 10) return 8;
    if (duration === 15) return 12;
    // Если значение уже поддерживается, возвращаем как есть
    if ([4, 8, 12].includes(duration)) return duration;
    // Для других значений возвращаем ближайшее поддерживаемое
    if (duration < 6) return 4;
    if (duration < 11) return 8;
    return 12;
  }

  /**
   * Изменяет размер изображения до указанных ширины и высоты
   * @param image - Buffer изображения
   * @param width - целевая ширина
   * @param height - целевая высота
   * @returns Promise<Buffer> - изображение с измененным размером
   */
  private async resizeImageForVideo(image: Buffer, width: number, height: number): Promise<Buffer> {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `${crypto.randomUUID()}.src`);
    const outPath = path.join(tmpDir, `${crypto.randomUUID()}.png`);

    try {
      await fs.writeFile(inputPath, image);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-vf',
            `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
            '-compression_level',
            '9',
          ])
          .output(outPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const result = await fs.readFile(outPath);
      this.logger.debug(`Изображение изменено до ${width}x${height}, размер: ${result.length} байт`);
      return result;
    } finally {
      await Promise.allSettled([fs.unlink(inputPath), fs.unlink(outPath)]);
    }
  }

  // ==================== OpenAI Video API Methods ====================

  /**
   * Генерирует видео через OpenAI API (text-to-video)
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse>
   */
  private async generateVideoOpenAI(prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    try {
      this.logger.log(`Начинаю генерацию видео через OpenAI для промпта: ${prompt}`);

      // Оптимизируем промт через ассистента (если не пропущена оптимизация)
      const optimizedPrompt = options?.skipOptimization
        ? prompt
        : await this.openaiService.optimizeVideoPrompt(prompt);
      this.logger.log(`Использую ${options?.skipOptimization ? 'исходный' : 'оптимизированный'} промт: ${optimizedPrompt}`);

      // Определяем параметры в зависимости от качества
      const quality = options?.quality || 'lite';
      const model = quality === 'pro' ? 'sora-2-pro' : 'sora-2';
      const size = quality === 'pro' ? '1024x1792' : '720x1280';

      // Создаем запрос на генерацию видео
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', optimizedPrompt);
      formData.append('size', size);
      const normalizedDuration = this.normalizeDurationForOpenAI(options?.duration);
      formData.append('seconds', String(normalizedDuration));

      const response = await fetch(`${this.openai.baseURL}/videos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openai.apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData as any,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ошибка OpenAI Video API: ${response.status} - ${errorText}`);
        return {
          success: false,
          error: `Ошибка API: ${response.status}`,
        };
      }

      const data = await response.json();
      this.logger.debug(`Получен ответ от OpenAI Video API: ${JSON.stringify(data)}`);

      const videoJobId = data.id;
      if (!videoJobId) {
        this.logger.error('Отсутствует ID задачи в ответе OpenAI');
        return {
          success: false,
          error: 'Отсутствует ID задачи',
        };
      }

      this.logger.log(`Задача создана, ID: ${videoJobId}, статус: ${data.status}`);
      return await this.waitForVideoCompletionOpenAI(videoJobId, options);
    } catch (error) {
      this.logger.error('Ошибка при генерации видео через OpenAI', error);
      return {
        success: false,
        error: 'Внутренняя ошибка сервера',
      };
    }
  }

  /**
   * Генерирует видео на основе изображения через OpenAI API (image-to-video)
   * @param imageBuffer - Buffer изображения
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse>
   */
  private async generateVideoFromImageOpenAI(
    imageBuffer: Buffer,
    prompt: string,
    options?: VideoGenerationOptions,
  ): Promise<VideoGenerationResponse> {
    try {
      this.logger.log(`Начинаю генерацию видео через OpenAI по изображению для промпта: ${prompt}`);

      // Оптимизируем промт через ассистента (если не пропущена оптимизация)
      const optimizedPrompt = options?.skipOptimization
        ? prompt
        : await this.openaiService.optimizeVideoPrompt(prompt);
      this.logger.log(`Использую ${options?.skipOptimization ? 'исходный' : 'оптимизированный'} промт: ${optimizedPrompt}`);

      // Определяем параметры в зависимости от качества
      const quality = options?.quality || 'lite';
      const model = quality === 'pro' ? 'sora-2-pro' : 'sora-2';
      const width = quality === 'pro' ? 1024 : 720;
      const height = quality === 'pro' ? 1792 : 1280;
      const size = quality === 'pro' ? '1024x1792' : '720x1280';

      // Изменяем размер изображения в соответствии с выбранным качеством
      this.logger.debug(`Изменяю размер изображения до ${size}...`);
      const resizedImage = await this.resizeImageForVideo(imageBuffer, width, height);

      // Создаем FormData и добавляем файл напрямую
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', optimizedPrompt);
      // Конвертируем Buffer в Readable stream для form-data
      const imageStream = Readable.from(resizedImage);
      formData.append('input_reference', imageStream, {
        filename: 'reference.png',
        contentType: 'image/png',
      });
      formData.append('size', size);
      const normalizedDuration = this.normalizeDurationForOpenAI(options?.duration);
      formData.append('seconds', String(normalizedDuration));

      const response = await fetch(`${this.openai.baseURL}/videos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openai.apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData as any,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ошибка OpenAI Video API (image2video): ${response.status} - ${errorText}`);
        return {
          success: false,
          error: `Ошибка API: ${response.status}`,
        };
      }

      const data = await response.json();
      this.logger.debug(`Получен ответ от OpenAI Video API (image2video): ${JSON.stringify(data)}`);

      const videoJobId = data.id;
      if (!videoJobId) {
        this.logger.error('Отсутствует ID задачи в ответе OpenAI');
        return {
          success: false,
          error: 'Отсутствует ID задачи',
        };
      }

      this.logger.log(`Задача image2video создана, ID: ${videoJobId}, статус: ${data.status}`);
      return await this.waitForVideoCompletionOpenAI(videoJobId, options);
    } catch (error) {
      this.logger.error('Ошибка при генерации видео по изображению через OpenAI', error);
      return {
        success: false,
        error: 'Внутренняя ошибка сервера',
      };
    }
  }

  /**
   * Ожидает завершения генерации видео в OpenAI и возвращает результат
   * @param videoJobId - ID задачи видео в OpenAI
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse>
   */
  private async waitForVideoCompletionOpenAI(videoJobId: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    const maxAttempts = 60; // максимум 10 минут ожидания (60 * 10 секунд)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 10000)); // ждем 10 секунд

        const statusUrl = `${this.openai.baseURL}/videos/${videoJobId}`;
        this.logger.debug(`Проверяю статус OpenAI видео по URL: ${statusUrl}`);

        const response = await fetch(statusUrl, {
          headers: {
            Authorization: `Bearer ${this.openai.apiKey}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`Ошибка при проверке статуса OpenAI видео: ${response.status} - ${errorText}`);

          // Если это временная ошибка, продолжаем попытки
          if (response.status >= 400 && response.status < 600) {
            this.logger.warn(`Временная ошибка API (${response.status}), продолжаю попытки...`);
            attempts++;
            continue;
          }

          return {
            success: false,
            error: 'Ошибка при проверке статуса видео',
          };
        }

        const data = await response.json();
        this.logger.debug(`Получен ответ при проверке статуса OpenAI: ${JSON.stringify(data)}`);

        const status = data.status;
        const progress = data.progress || 0;

        if (status === 'completed') {
          // Для OpenAI API видео доступно через специальный endpoint
          // Сначала проверяем, есть ли прямой URL в ответе
          let videoUrl = data.output?.url || data.url || data.output?.download_url || data.download_url;

          // Если прямого URL нет, формируем URL для скачивания через Files API
          if (!videoUrl) {
            // Проверяем, есть ли file_id
            const fileId = data.output?.file_id || data.file_id;
            if (fileId) {
              videoUrl = `${this.openai.baseURL}/files/${fileId}/content`;
              this.logger.debug(`Использую Files API для скачивания: ${videoUrl}`);
            } else {
              // Используем прямой endpoint для скачивания видео
              videoUrl = `${this.openai.baseURL}/videos/${videoJobId}/content`;
              this.logger.debug(`Использую Video API для скачивания: ${videoUrl}`);
            }
          }

          this.logger.log('Видео через OpenAI успешно сгенерировано');
          this.logger.debug(`URL видео: ${videoUrl}`);
          return {
            success: true,
            videoUrl: videoUrl,
          };
        } else if (status === 'failed') {
          const errorCode = data.error?.code;
          const errorMsg = data.error?.message || 'Генерация видео завершилась с ошибкой';
          
          // Специальная обработка ошибки модерации
          let userFriendlyError: string;
          if (errorCode === 'moderation_blocked') {
            userFriendlyError = 'Запрос был заблокирован системой модерации. Пожалуйста, измените описание видео, избегая упоминания алкоголя, оружия или других запрещенных тем.';
          } else if (errorMsg.includes('moderation') || errorMsg.includes('blocked')) {
            userFriendlyError = 'Запрос был заблокирован системой модерации. Пожалуйста, измените описание видео.';
          } else {
            userFriendlyError = errorMsg;
          }
          
          this.logger.error(`Генерация OpenAI видео завершилась с ошибкой: ${errorMsg} (код: ${errorCode})`);
          return {
            success: false,
            error: userFriendlyError,
          };
        } else if (status === 'queued' || status === 'processing' || status === 'in_progress') {
          this.logger.debug(`Задача OpenAI все еще обрабатывается, статус: ${status}, прогресс: ${progress}%`);
        }

        attempts++;
        this.logger.debug(`Попытка ${attempts}/${maxAttempts}: статус OpenAI видео - ${status}, прогресс: ${progress}%`);

        // Вызываем callback для обновления прогресса
        if (options?.onProgress) {
          let statusText: string;
          if (status === 'queued') {
            statusText = 'в очереди';
          } else if (status === 'processing' || status === 'in_progress') {
            statusText = `обрабатывается (${progress}%)`;
          } else {
            statusText = status;
          }
          options.onProgress(statusText, attempts, maxAttempts);
        }
      } catch (error) {
        this.logger.error('Ошибка при проверке статуса OpenAI видео', error);
        return {
          success: false,
          error: 'Ошибка при проверке статуса видео',
        };
      }
    }

    this.logger.error('Превышено время ожидания генерации OpenAI видео');
    return {
      success: false,
      error: 'Превышено время ожидания генерации видео',
    };
  }

  /**
   * Получает URL для скачивания видео из OpenAI
   * @param videoJobId - ID задачи видео
   * @returns Promise<string | null>
   */
  private async getOpenAIVideoUrl(videoJobId: string): Promise<string | null> {
    try {
      // Получаем информацию о видео задаче
      const response = await fetch(`${this.openai.baseURL}/videos/${videoJobId}`, {
        headers: {
          Authorization: `Bearer ${this.openai.apiKey}`,
        },
      });

      if (!response.ok) {
        this.logger.error(`Ошибка при получении информации о видео: ${response.status}`);
        return null;
      }

      // В OpenAI видео может быть доступно напрямую через URL или через файл
      // Возвращаем временный URL для скачивания (как в случае с файлами)
      return `${this.openai.baseURL}/videos/${videoJobId}/download`;
    } catch (error) {
      this.logger.error('Ошибка при получении URL OpenAI видео', error);
      return null;
    }
  }

  // ==================== Kling API Methods ====================

  private generateJWTToken(): string {
    try {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: this.klingAccessKey, // issuer (access key)
        exp: now + 1800, // expires in 30 minutes (1800 seconds)
        nbf: now - 5, // not before (5 seconds ago)
      };

      const header = {
        alg: 'HS256',
        typ: 'JWT',
      };

      return jwt.sign(payload, this.klingSecretKey, {
        algorithm: 'HS256',
        header: header,
      });
    } catch (error) {
      this.logger.error('Ошибка при генерации JWT токена', error);
      throw new Error('Не удалось сгенерировать JWT токен');
    }
  }

  /**
   * Конвертирует Buffer изображения в base64 строку без префикса
   * @param imageBuffer - Buffer изображения
   * @returns строка base64 без префикса data:image/...
   */
  private convertImageToBase64(imageBuffer: Buffer): string {
    return imageBuffer.toString('base64');
  }

  /**
   * Генерирует видео на основе изображения и текстового промпта через Kling API
   * @param imageBuffer - Buffer изображения
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse> - результат генерации
   */
  private async generateVideoFromImageKling(imageBuffer: Buffer, prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    try {
      if (!this.klingAccessKey || !this.klingSecretKey) {
        return {
          success: false,
          error: 'Ключи доступа Kling не настроены',
        };
      }

      this.logger.log(`Начинаю генерацию видео по изображению через Kling для промпта: ${prompt}`);

      // Оптимизируем промт через ассистента (если не пропущена оптимизация)
      const optimizedPrompt = options?.skipOptimization
        ? prompt
        : await this.openaiService.optimizeVideoPrompt(prompt);
      this.logger.log(`Использую ${options?.skipOptimization ? 'исходный' : 'оптимизированный'} промт: ${optimizedPrompt}`);

      // Конвертируем изображение в base64
      const imageBase64 = this.convertImageToBase64(imageBuffer);
      this.logger.debug(`Изображение конвертировано в base64, размер: ${imageBase64.length} символов`);

      // Генерируем JWT токен для авторизации
      const jwtToken = this.generateJWTToken();
      this.logger.debug(`JWT токен сгенерирован для запроса`);

      const requestBody = {
        model_name: 'kling-v1-6',
        mode: 'std',
        duration: String(options?.duration ?? 5),
        image: imageBase64,
        prompt: optimizedPrompt,
        cfg_scale: 0.5,
      };

      this.logger.debug(`Отправляю запрос на ${this.klingApiUrl}/v1/videos/image2video`);
      this.logger.debug(`Тело запроса: ${JSON.stringify({ ...requestBody, image: `[base64 data ${imageBase64.length} chars]` })}`);

      const headers = {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      };

      // Создаем запрос на генерацию видео по изображению
      const response = await fetch(`${this.klingApiUrl}/v1/videos/image2video`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ошибка API Kling: ${response.status} - ${errorText}`);
        this.logger.error(`Заголовки ответа: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
        return {
          success: false,
          error: `Ошибка API: ${response.status}`,
        };
      }

      const data = await response.json();
      this.logger.debug(`Получен ответ от API: ${JSON.stringify(data)}`);

      // Проверяем различные возможные структуры ответа
      const status = data?.status || data?.data?.status || data?.data?.task_status || data?.result?.status;
      const videoUrl = data?.video_url || data?.url || data?.data?.video_url || data?.data?.url;
      const taskId = data?.id || data?.task_id || data?.data?.id || data?.data?.task_id;

      this.logger.debug(`Извлеченный статус: ${status}`);
      this.logger.debug(`Извлеченный URL видео: ${videoUrl}`);
      this.logger.debug(`Извлеченный ID задачи: ${taskId}`);

      if (status === 'succeed' && videoUrl) {
        this.logger.log('Видео по изображению успешно сгенерировано');
        return {
          success: true,
          videoUrl: videoUrl,
        };
      } else if (status === 'processing' || status === 'submitted') {
        // Если видео еще обрабатывается, ждем и проверяем статус
        if (!taskId) {
          this.logger.error('Отсутствует ID задачи для отслеживания статуса');
          return {
            success: false,
            error: 'Отсутствует ID задачи для отслеживания статуса',
          };
        }
        this.logger.log(`Задача отправлена, ID: ${taskId}, статус: ${status}`);
        return await this.waitForVideoCompletionImage2VideoKling(taskId, options);
      } else {
        this.logger.error(`Неожиданный статус ответа: ${status}`);
        this.logger.error(`Полный ответ API: ${JSON.stringify(data)}`);
        return {
          success: false,
          error: `Неожиданный статус: ${status || 'undefined'}`,
        };
      }
    } catch (error) {
      this.logger.error('Ошибка при генерации видео по изображению через Kling', error);
      return {
        success: false,
        error: 'Внутренняя ошибка сервера',
      };
    }
  }

  /**
   * Генерирует видео на основе текстового промпта через Kling API
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse> - результат генерации
   */
  private async generateVideoKling(prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    try {
      if (!this.klingAccessKey || !this.klingSecretKey) {
        return {
          success: false,
          error: 'Ключи доступа Kling не настроены',
        };
      }

      this.logger.log(`Начинаю генерацию видео через Kling для промпта: ${prompt}`);

      // Оптимизируем промт через ассистента (если не пропущена оптимизация)
      const optimizedPrompt = options?.skipOptimization
        ? prompt
        : await this.openaiService.optimizeVideoPrompt(prompt);
      this.logger.log(`Использую ${options?.skipOptimization ? 'исходный' : 'оптимизированный'} промт: ${optimizedPrompt}`);

      // Генерируем JWT токен для авторизации
      const jwtToken = this.generateJWTToken();
      this.logger.debug(`JWT токен сгенерирован для запроса`);
      this.logger.debug(`JWT токен: ${jwtToken}`);
      this.logger.debug(`Access Key: ${this.klingAccessKey}`);
      this.logger.debug(`Secret Key: ${this.klingSecretKey ? '***' + this.klingSecretKey.slice(-4) : 'не задан'}`);

      const requestBody = {
        model_name: 'kling-v1-6',
        prompt: optimizedPrompt,
        duration: String(options?.duration ?? 5), // длительность в секундах (строка согласно документации)
        aspect_ratio: '1:1', // квадратное видео
        mode: 'std', // стандартный режим
      };

      this.logger.debug(`Отправляю запрос на ${this.klingApiUrl}/v1/videos/text2video`);
      this.logger.debug(`Тело запроса: ${JSON.stringify(requestBody)}`);

      const headers = {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      };
      this.logger.debug(`Заголовки запроса: ${JSON.stringify(headers)}`);

      // Создаем запрос на генерацию видео
      const response = await fetch(`${this.klingApiUrl}/v1/videos/text2video`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ошибка API Kling: ${response.status} - ${errorText}`);
        this.logger.error(`Заголовки ответа: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
        return {
          success: false,
          error: `Ошибка API: ${response.status}`,
        };
      }

      const data = await response.json();
      this.logger.debug(`Получен ответ от API: ${JSON.stringify(data)}`);
      this.logger.debug(`Тип данных: ${typeof data}`);
      this.logger.debug(`Ключи в ответе: ${Object.keys(data || {}).join(', ')}`);

      // Проверяем различные возможные структуры ответа
      const status = data?.status || data?.data?.status || data?.data?.task_status || data?.result?.status;
      const videoUrl = data?.video_url || data?.url || data?.data?.video_url || data?.data?.url;
      const taskId = data?.id || data?.task_id || data?.data?.id || data?.data?.task_id;

      this.logger.debug(`Извлеченный статус: ${status}`);
      this.logger.debug(`Извлеченный URL видео: ${videoUrl}`);
      this.logger.debug(`Извлеченный ID задачи: ${taskId}`);

      if (status === 'succeed' && videoUrl) {
        this.logger.log('Видео успешно сгенерировано');
        return {
          success: true,
          videoUrl: videoUrl,
        };
      } else if (status === 'processing' || status === 'submitted') {
        // Если видео еще обрабатывается, ждем и проверяем статус
        if (!taskId) {
          this.logger.error('Отсутствует ID задачи для отслеживания статуса');
          return {
            success: false,
            error: 'Отсутствует ID задачи для отслеживания статуса',
          };
        }
        this.logger.log(`Задача отправлена, ID: ${taskId}, статус: ${status}`);
        return await this.waitForVideoCompletionKling(taskId, options);
      } else {
        this.logger.error(`Неожиданный статус ответа: ${status}`);
        this.logger.error(`Полный ответ API: ${JSON.stringify(data)}`);
        return {
          success: false,
          error: `Неожиданный статус: ${status || 'undefined'}`,
        };
      }
    } catch (error) {
      this.logger.error('Ошибка при генерации видео через Kling', error);
      return {
        success: false,
        error: 'Внутренняя ошибка сервера',
      };
    }
  }

  /**
   * Ожидает завершения генерации видео Kling и возвращает результат
   * @param videoId - ID видео в API Kling
   * @returns Promise<VideoGenerationResponse>
   */
  private async waitForVideoCompletionKling(videoId: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    const maxAttempts = 30; // максимум 5 минут ожидания (30 * 10 секунд)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 10000)); // ждем 10 секунд

        // Генерируем новый JWT токен для каждого запроса
        const jwtToken = this.generateJWTToken();

        const statusUrl = `${this.klingApiUrl}/v1/videos/text2video/${videoId}`;
        this.logger.debug(`Проверяю статус по URL: ${statusUrl}`);

        const response = await fetch(statusUrl, {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`Ошибка при проверке статуса видео: ${response.status} - ${errorText}`);

          // Если это временная ошибка (400, 500), продолжаем попытки
          if (response.status >= 400 && response.status < 600) {
            this.logger.warn(`Временная ошибка API (${response.status}), продолжаю попытки...`);
            attempts++;
            continue;
          }

          return {
            success: false,
            error: 'Ошибка при проверке статуса видео',
          };
        }

        const data = await response.json();
        this.logger.debug(`Получен ответ при проверке статуса: ${JSON.stringify(data)}`);

        // Проверяем различные возможные структуры ответа согласно документации
        const status = data?.data?.task_status || data?.status || data?.data?.status || data?.result?.status;
        const videoUrl = data?.data?.task_result?.videos?.[0]?.url || data?.video_url || data?.url || data?.data?.video_url || data?.data?.url;
        const error = data?.data?.task_status_msg || data?.error || data?.message || data?.data?.error || data?.data?.message;

        this.logger.debug(`Извлеченный статус при проверке: ${status}`);
        this.logger.debug(`Извлеченный URL видео при проверке: ${videoUrl}`);

        if (status === 'succeed' && videoUrl) {
          this.logger.log('Видео успешно сгенерировано после ожидания');
          return {
            success: true,
            videoUrl: videoUrl,
          };
        } else if (status === 'failed') {
          this.logger.error(`Генерация видео завершилась с ошибкой: ${error}`);
          return {
            success: false,
            error: error || 'Генерация видео завершилась с ошибкой',
          };
        } else if (status === 'submitted' || status === 'processing') {
          this.logger.debug(`Задача все еще обрабатывается, статус: ${status}`);
        }

        attempts++;
        this.logger.debug(`Попытка ${attempts}/${maxAttempts}: статус видео - ${status}`);

        // Вызываем callback для обновления прогресса
        if (options?.onProgress) {
          // Примерно вычисляем прогресс на основе попыток (Kling API не предоставляет точный процент)
          const estimatedProgress = Math.min(Math.round((attempts / maxAttempts) * 100), 99);
          const statusText = status === 'submitted' ? 'в очереди' : status === 'processing' ? `обрабатывается (${estimatedProgress}%)` : status;
          options.onProgress(statusText, attempts, maxAttempts);
        }
      } catch (error) {
        this.logger.error('Ошибка при проверке статуса видео', error);
        return {
          success: false,
          error: 'Ошибка при проверке статуса видео',
        };
      }
    }

    this.logger.error('Превышено время ожидания генерации видео');
    return {
      success: false,
      error: 'Превышено время ожидания генерации видео',
    };
  }

  /**
   * Ожидает завершения генерации видео по изображению Kling и возвращает результат
   * @param videoId - ID видео в API Kling
   * @returns Promise<VideoGenerationResponse>
   */
  private async waitForVideoCompletionImage2VideoKling(videoId: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    const maxAttempts = 30; // максимум 5 минут ожидания (30 * 10 секунд)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 10000)); // ждем 10 секунд

        // Генерируем новый JWT токен для каждого запроса
        const jwtToken = this.generateJWTToken();

        const statusUrl = `${this.klingApiUrl}/v1/videos/image2video/${videoId}`;
        this.logger.debug(`Проверяю статус image2video по URL: ${statusUrl}`);

        const response = await fetch(statusUrl, {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`Ошибка при проверке статуса видео image2video: ${response.status} - ${errorText}`);

          // Если это временная ошибка (400, 500), продолжаем попытки
          if (response.status >= 400 && response.status < 600) {
            this.logger.warn(`Временная ошибка API (${response.status}), продолжаю попытки...`);
            attempts++;
            continue;
          }

          return {
            success: false,
            error: 'Ошибка при проверке статуса видео',
          };
        }

        const data = await response.json();
        this.logger.debug(`Получен ответ при проверке статуса image2video: ${JSON.stringify(data)}`);

        // Проверяем различные возможные структуры ответа согласно документации
        const status = data?.data?.task_status || data?.status || data?.data?.status || data?.result?.status;
        const videoUrl = data?.data?.task_result?.videos?.[0]?.url || data?.video_url || data?.url || data?.data?.video_url || data?.data?.url;
        const error = data?.data?.task_status_msg || data?.error || data?.message || data?.data?.error || data?.data?.message;

        this.logger.debug(`Извлеченный статус при проверке image2video: ${status}`);
        this.logger.debug(`Извлеченный URL видео при проверке image2video: ${videoUrl}`);

        if (status === 'succeed' && videoUrl) {
          this.logger.log('Видео по изображению успешно сгенерировано после ожидания');
          return {
            success: true,
            videoUrl: videoUrl,
          };
        } else if (status === 'failed') {
          this.logger.error(`Генерация видео по изображению завершилась с ошибкой: ${error}`);
          return {
            success: false,
            error: error || 'Генерация видео по изображению завершилась с ошибкой',
          };
        } else if (status === 'submitted' || status === 'processing') {
          this.logger.debug(`Задача image2video все еще обрабатывается, статус: ${status}`);
        }

        attempts++;
        this.logger.debug(`Попытка ${attempts}/${maxAttempts}: статус видео image2video - ${status}`);

        // Вызываем callback для обновления прогресса
        if (options?.onProgress) {
          // Примерно вычисляем прогресс на основе попыток (Kling API не предоставляет точный процент)
          const estimatedProgress = Math.min(Math.round((attempts / maxAttempts) * 100), 99);
          const statusText = status === 'submitted' ? 'в очереди' : status === 'processing' ? `обрабатывается (${estimatedProgress}%)` : status;
          options.onProgress(statusText, attempts, maxAttempts);
        }
      } catch (error) {
        this.logger.error('Ошибка при проверке статуса видео image2video', error);
        return {
          success: false,
          error: 'Ошибка при проверке статуса видео',
        };
      }
    }

    this.logger.error('Превышено время ожидания генерации видео по изображению');
    return {
      success: false,
      error: 'Превышено время ожидания генерации видео по изображению',
    };
  }

  // ==================== Public Methods with Provider Selection ====================

  /**
   * Генерирует видео на основе текстового промпта
   * Автоматически выбирает провайдера на основе настроек или опций
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse> - результат генерации
   */
  async generateVideo(prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    const provider = options?.provider || this.defaultProvider;
    this.logger.log(`Генерация видео с использованием провайдера: ${provider}`);

    if (provider === VideoProvider.OPENAI) {
      return await this.generateVideoOpenAI(prompt, options);
    } else {
      return await this.generateVideoKling(prompt, options);
    }
  }

  /**
   * Генерирует видео на основе изображения и текстового промпта
   * Автоматически выбирает провайдера на основе настроек или опций
   * @param imageBuffer - Buffer изображения
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse> - результат генерации
   */
  async generateVideoFromImage(imageBuffer: Buffer, prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    const provider = options?.provider || this.defaultProvider;
    this.logger.log(`Генерация видео по изображению с использованием провайдера: ${provider}`);

    if (provider === VideoProvider.OPENAI) {
      return await this.generateVideoFromImageOpenAI(imageBuffer, prompt, options);
    } else {
      return await this.generateVideoFromImageKling(imageBuffer, prompt, options);
    }
  }

  /**
   * Скачивает видео по URL и возвращает как Buffer
   * Автоматически определяет провайдера и добавляет необходимые заголовки
   * @param videoUrl - URL видео
   * @returns Promise<Buffer | null>
   */
  async downloadVideo(videoUrl: string): Promise<Buffer | null> {
    try {
      this.logger.log(`Скачиваю видео: ${videoUrl}`);

      // Проверяем, нужна ли авторизация для OpenAI
      const baseUrl = this.openai.baseURL.replace(/\/v1$/, '').replace(/\/$/, '');
      const isOpenAIUrl =
        (videoUrl.includes('/videos/') || videoUrl.includes('/files/')) &&
        (videoUrl.includes('api.openai.com') || videoUrl.includes(baseUrl) || videoUrl.startsWith(this.openai.baseURL));

      const headers: Record<string, string> = {};
      if (isOpenAIUrl) {
        headers['Authorization'] = `Bearer ${this.openai.apiKey}`;
        this.logger.debug('Добавлен Authorization заголовок для OpenAI URL');
      }

      this.logger.debug(`Заголовки для скачивания: ${JSON.stringify(headers)}`);

      const response = await fetch(videoUrl, { headers });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ошибка при скачивании видео: ${response.status}`);
        this.logger.error(`Тело ответа: ${errorText}`);
        this.logger.error(`URL: ${videoUrl}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      this.logger.log(`Видео успешно скачано, размер: ${buffer.length} байт`);

      return buffer;
    } catch (error) {
      this.logger.error('Ошибка при скачивании видео', error);
      this.logger.error(`URL который пытались скачать: ${videoUrl}`);
      return null;
    }
  }
}
