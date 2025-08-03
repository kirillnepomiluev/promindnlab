import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiService } from '../../openai/openai.service/openai.service';
import fetch from 'node-fetch';
import * as jwt from 'jsonwebtoken';

export interface VideoGenerationResponse {
  success: boolean;
  videoUrl?: string;
  error?: string;
}

export interface VideoGenerationOptions {
  onProgress?: (status: string, attempt: number, maxAttempts: number) => void;
}

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);
  private readonly klingAccessKey: string;
  private readonly klingSecretKey: string;
  private readonly klingApiUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly openaiService: OpenAiService,
  ) {
    this.klingAccessKey = this.configService.get<string>('KLING_ACCESS_KEY');
    this.klingSecretKey = this.configService.get<string>('KLING_SECRET_KEY');
    this.klingApiUrl = this.configService.get<string>('KLING_API_URL') || 'https://api.klingai.com';
    
    if (!this.klingAccessKey || !this.klingSecretKey) {
      this.logger.error('KLING_ACCESS_KEY или KLING_SECRET_KEY не заданы в переменных окружения');
    }
  }

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
        header: header 
      });
    } catch (error) {
      this.logger.error('Ошибка при генерации JWT токена', error);
      throw new Error('Не удалось сгенерировать JWT токен');
    }
  }

  /**
   * Генерирует видео на основе текстового промпта
   * @param prompt - текстовое описание для генерации видео
   * @param options - опции для генерации
   * @returns Promise<VideoGenerationResponse> - результат генерации
   */
  async generateVideo(prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    try {
      if (!this.klingAccessKey || !this.klingSecretKey) {
        return {
          success: false,
          error: 'Ключи доступа Kling не настроены',
        };
      }

      this.logger.log(`Начинаю генерацию видео для промпта: ${prompt}`);

      // Оптимизируем промт через ассистента
      const optimizedPrompt = await this.openaiService.optimizeVideoPrompt(prompt);
      this.logger.log(`Использую оптимизированный промт: ${optimizedPrompt}`);

      // Генерируем JWT токен для авторизации
      const jwtToken = this.generateJWTToken();
      this.logger.debug(`JWT токен сгенерирован для запроса`);
      this.logger.debug(`JWT токен: ${jwtToken}`);
      this.logger.debug(`Access Key: ${this.klingAccessKey}`);
      this.logger.debug(`Secret Key: ${this.klingSecretKey ? '***' + this.klingSecretKey.slice(-4) : 'не задан'}`);

      const requestBody = {
        model_name: 'kling-v2-1-master',
        prompt: optimizedPrompt,
        duration: '5', // 5 секунд как требовалось (строка согласно документации)
        aspect_ratio: '1:1', // квадратное видео
        mode: 'std', // стандартный режим
      };

      this.logger.debug(`Отправляю запрос на ${this.klingApiUrl}/v1/videos/text2video`);
      this.logger.debug(`Тело запроса: ${JSON.stringify(requestBody)}`);

      const headers = {
        'Authorization': `Bearer ${jwtToken}`,
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
        return await this.waitForVideoCompletion(taskId, options);
      } else {
        this.logger.error(`Неожиданный статус ответа: ${status}`);
        this.logger.error(`Полный ответ API: ${JSON.stringify(data)}`);
        return {
          success: false,
          error: `Неожиданный статус: ${status || 'undefined'}`,
        };
      }
    } catch (error) {
      this.logger.error('Ошибка при генерации видео', error);
      return {
        success: false,
        error: 'Внутренняя ошибка сервера',
      };
    }
  }

  /**
   * Ожидает завершения генерации видео и возвращает результат
   * @param videoId - ID видео в API Kling
   * @returns Promise<VideoGenerationResponse>
   */
  private async waitForVideoCompletion(videoId: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse> {
    const maxAttempts = 30; // максимум 5 минут ожидания (30 * 10 секунд)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        await new Promise(resolve => setTimeout(resolve, 10000)); // ждем 10 секунд

        // Генерируем новый JWT токен для каждого запроса
        const jwtToken = this.generateJWTToken();
        
        const statusUrl = `${this.klingApiUrl}/v1/videos/text2video/${videoId}`;
        this.logger.debug(`Проверяю статус по URL: ${statusUrl}`);
        
        const response = await fetch(statusUrl, {
          headers: {
            'Authorization': `Bearer ${jwtToken}`,
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
          const elapsedSeconds = attempts * 10;
          const statusText = status === 'submitted' ? 'отправлена' : 
                           status === 'processing' ? 'обрабатывается' : status;
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
   * Скачивает видео по URL и возвращает как Buffer
   * @param videoUrl - URL видео
   * @returns Promise<Buffer | null>
   */
  async downloadVideo(videoUrl: string): Promise<Buffer | null> {
    try {
      this.logger.log(`Скачиваю видео: ${videoUrl}`);
      
      const response = await fetch(videoUrl);
      if (!response.ok) {
        this.logger.error(`Ошибка при скачивании видео: ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      this.logger.log(`Видео успешно скачано, размер: ${buffer.length} байт`);
      
      return buffer;
    } catch (error) {
      this.logger.error('Ошибка при скачивании видео', error);
      return null;
    }
  }
} 