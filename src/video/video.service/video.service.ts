import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fetch from 'node-fetch';
import * as jwt from 'jsonwebtoken';

export interface VideoGenerationResponse {
  success: boolean;
  videoUrl?: string;
  error?: string;
}

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);
  private readonly klingAccessKey: string;
  private readonly klingSecretKey: string;
  private readonly klingApiUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.klingAccessKey = this.configService.get<string>('KLING_ACCESS_KEY');
    this.klingSecretKey = this.configService.get<string>('KLING_SECRET_KEY');
    this.klingApiUrl = this.configService.get<string>('KLING_API_URL') || 'https://api.kling.com';
    
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
   * @returns Promise<VideoGenerationResponse> - результат генерации
   */
  async generateVideo(prompt: string): Promise<VideoGenerationResponse> {
    try {
      if (!this.klingAccessKey || !this.klingSecretKey) {
        return {
          success: false,
          error: 'Ключи доступа Kling не настроены',
        };
      }

      this.logger.log(`Начинаю генерацию видео для промпта: ${prompt}`);

      // Генерируем JWT токен для авторизации
      const jwtToken = this.generateJWTToken();

      // Создаем запрос на генерацию видео
      const response = await fetch(`${this.klingApiUrl}/v1/videos/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt,
          duration: 5, // 5 секунд как требовалось
          aspect_ratio: '1:1', // квадратное видео
          fps: 24,
          quality: 'medium',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ошибка API Kling: ${response.status} - ${errorText}`);
        return {
          success: false,
          error: `Ошибка API: ${response.status}`,
        };
      }

      const data = await response.json();
      
      if (data.status === 'completed' && data.video_url) {
        this.logger.log('Видео успешно сгенерировано');
        return {
          success: true,
          videoUrl: data.video_url,
        };
      } else if (data.status === 'processing') {
        // Если видео еще обрабатывается, ждем и проверяем статус
        return await this.waitForVideoCompletion(data.id);
      } else {
        this.logger.error(`Неожиданный статус ответа: ${data.status}`);
        return {
          success: false,
          error: `Неожиданный статус: ${data.status}`,
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
  private async waitForVideoCompletion(videoId: string): Promise<VideoGenerationResponse> {
    const maxAttempts = 60; // максимум 5 минут ожидания (60 * 5 секунд)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        await new Promise(resolve => setTimeout(resolve, 5000)); // ждем 5 секунд

        // Генерируем новый JWT токен для каждого запроса
        const jwtToken = this.generateJWTToken();
        
        const response = await fetch(`${this.klingApiUrl}/v1/videos/${videoId}`, {
          headers: {
            'Authorization': `Bearer ${jwtToken}`,
          },
        });

        if (!response.ok) {
          this.logger.error(`Ошибка при проверке статуса видео: ${response.status}`);
          return {
            success: false,
            error: 'Ошибка при проверке статуса видео',
          };
        }

        const data = await response.json();

        if (data.status === 'completed' && data.video_url) {
          this.logger.log('Видео успешно сгенерировано после ожидания');
          return {
            success: true,
            videoUrl: data.video_url,
          };
        } else if (data.status === 'failed') {
          this.logger.error(`Генерация видео завершилась с ошибкой: ${data.error}`);
          return {
            success: false,
            error: data.error || 'Генерация видео завершилась с ошибкой',
          };
        }

        attempts++;
        this.logger.debug(`Попытка ${attempts}/${maxAttempts}: статус видео - ${data.status}`);
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