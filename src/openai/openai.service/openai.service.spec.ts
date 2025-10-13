import { Test, TestingModule } from '@nestjs/testing';
import { OpenAiService } from './openai.service';
import { ConfigService } from '@nestjs/config';
import { SessionService } from '../../session/session.service';

describe('OpenaiService', () => {
  let provider: OpenAiService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockSessionService: jest.Mocked<SessionService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'OPENAI_API_KEY_PRO') return 'test-api-key';
        if (key === 'OPENAI_BASE_URL_PRO') return 'https://test.com/v1';
        return undefined;
      }),
    } as any;

    mockSessionService = {
      getSessionId: jest.fn(),
      setSessionId: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [OpenAiService, { provide: ConfigService, useValue: mockConfigService }, { provide: SessionService, useValue: mockSessionService }],
    }).compile();

    provider = module.get<OpenAiService>(OpenAiService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  describe('Thread Locking System', () => {
    it('should allow different threads to work in parallel', async () => {
      // Создаем два разных threadId
      const thread1 = 'thread-1';
      const thread2 = 'thread-2';

      // Проверяем, что оба треда изначально свободны
      expect(provider['isThreadActive'](thread1)).toBe(false);
      expect(provider['isThreadActive'](thread2)).toBe(false);

      // Симулируем выполнение операций в разных тредах
      const operation1 = jest.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('result1'), 100)));
      const operation2 = jest.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('result2'), 50)));

      // Запускаем операции параллельно
      const promise1 = provider['lockThread'](thread1, operation1);
      const promise2 = provider['lockThread'](thread2, operation2);

      // Проверяем, что оба треда заблокированы
      expect(provider['isThreadActive'](thread1)).toBe(true);
      expect(provider['isThreadActive'](thread2)).toBe(true);

      // Ждем завершения обеих операций
      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Проверяем результаты
      expect(result1).toBe('result1');
      expect(result2).toBe('result2');

      // Проверяем, что оба треда разблокированы
      expect(provider['isThreadActive'](thread1)).toBe(false);
      expect(provider['isThreadActive'](thread2)).toBe(false);
    });

    it('should prevent multiple requests to the same thread', async () => {
      const threadId = 'test-thread';

      // Первая операция
      const operation1 = jest.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('result1'), 200)));

      // Вторая операция (должна быть заблокирована)
      const operation2 = jest.fn().mockImplementation(() => Promise.resolve('result2'));

      // Запускаем первую операцию
      const promise1 = provider['lockThread'](threadId, operation1);

      // Проверяем, что тред заблокирован
      expect(provider['isThreadActive'](threadId)).toBe(true);

      // Пытаемся запустить вторую операцию в том же треде
      await expect(provider['lockThread'](threadId, operation2)).rejects.toThrow('Тред уже занят другим запросом');

      // Ждем завершения первой операции
      const result1 = await promise1;
      expect(result1).toBe('result1');

      // Проверяем, что тред разблокирован
      expect(provider['isThreadActive'](threadId)).toBe(false);
    });

    it('should clean up thread lock on operation error', async () => {
      const threadId = 'error-thread';

      // Операция, которая завершается ошибкой
      const errorOperation = jest.fn().mockImplementation(() => Promise.reject(new Error('Test error')));

      // Пытаемся выполнить операцию
      await expect(provider['lockThread'](threadId, errorOperation)).rejects.toThrow('Test error');

      // Проверяем, что тред разблокирован даже после ошибки
      expect(provider['isThreadActive'](threadId)).toBe(false);
    });

    it('should return active threads status', () => {
      // Устанавливаем mock данные
      provider['threadMap'].set(1, 'thread-1');
      provider['threadMap'].set(2, 'thread-2');

      // Блокируем один тред
      provider['activeThreads'].set('thread-1', Promise.resolve('test'));

      const status = provider.getActiveThreadsStatus();

      expect(status).toHaveLength(2);
      expect(status.find((s) => s.threadId.includes('thread-1'))?.isActive).toBe(true);
      expect(status.find((s) => s.threadId.includes('thread-2'))?.isActive).toBe(false);
    });
  });
});
