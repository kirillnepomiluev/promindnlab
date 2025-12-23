# Миграция Video Service на OpenAI API

## Обзор изменений

Video Service теперь поддерживает два провайдера для генерации видео:
- **OpenAI** (Sora-2) - провайдер по умолчанию
- **Kling** - альтернативный провайдер

## Конфигурация

### Переменные окружения

Добавьте в ваш `.env` файл:

```env
# Провайдер видео по умолчанию: openai или kling
VIDEO_PROVIDER=openai

# OpenAI уже настроен через существующие переменные:
OPENAI_API_KEY_PRO=your_openai_api_key
OPENAI_BASE_URL_PRO=https://api.openai.com/v1

# Kling (опционально, только если используете kling):
KLING_ACCESS_KEY=your_kling_access_key
KLING_SECRET_KEY=your_kling_secret_key
KLING_API_URL=https://api-singapore.klingai.com
```

## Использование

### 1. Генерация видео по тексту

```typescript
// Использует провайдер по умолчанию (OpenAI)
const result = await videoService.generateVideo('A calico cat playing piano');

// Явное указание провайдера
const result = await videoService.generateVideo('A calico cat playing piano', {
  provider: VideoProvider.OPENAI
});

// Использование Kling
const result = await videoService.generateVideo('A calico cat playing piano', {
  provider: VideoProvider.KLING
});
```

### 2. Генерация видео по изображению

```typescript
// Использует провайдер по умолчанию (OpenAI)
const result = await videoService.generateVideoFromImage(imageBuffer, 'Make it dance');

// Явное указание провайдера
const result = await videoService.generateVideoFromImage(imageBuffer, 'Make it dance', {
  provider: VideoProvider.OPENAI
});
```

### 3. Отслеживание прогресса

```typescript
const result = await videoService.generateVideo('A beautiful sunset', {
  onProgress: (status, attempt, maxAttempts) => {
    console.log(`Статус: ${status}, Попытка: ${attempt}/${maxAttempts}`);
  }
});
```

## Особенности OpenAI Video API

### Параметры по умолчанию:
- **Модель**: `sora-2`
- **Размер**: `720x1280` (вертикальное видео)
- **Длительность**: `4` секунды
- **Оптимизация промпта**: Автоматическая оптимизация через ассистента

### Процесс генерации:
1. Промпт оптимизируется через OpenAI ассистента
2. Создается задача генерации видео
3. Статус проверяется каждые 10 секунд
4. Максимальное время ожидания: 10 минут (60 попыток)

## Особенности Kling API

### Параметры по умолчанию:
- **Модель**: `kling-v1-6`
- **Режим**: `std` (стандартный)
- **Длительность**: `5` секунд
- **Размер**: `1:1` (квадратное видео)
- **CFG Scale**: `0.5` (для image2video)

### Процесс генерации:
1. Промпт оптимизируется через OpenAI ассистента
2. Генерируется JWT токен для аутентификации
3. Создается задача генерации видео
4. Статус проверяется каждые 10 секунд
5. Максимальное время ожидания: 5 минут (30 попыток)

## Переключение между провайдерами

### Глобальное переключение

В `.env` файле измените:
```env
VIDEO_PROVIDER=kling  # или openai
```

### Программное переключение

```typescript
import { VideoProvider } from './video/video.service/video.service';

// Для конкретного запроса
const result = await videoService.generateVideo('Prompt', {
  provider: VideoProvider.KLING  // или VideoProvider.OPENAI
});
```

## Структура ответа

```typescript
interface VideoGenerationResponse {
  success: boolean;
  videoUrl?: string;  // URL для скачивания готового видео
  error?: string;     // Описание ошибки (если success = false)
}
```

## Скачивание видео

Метод `downloadVideo` автоматически определяет провайдера и добавляет необходимые заголовки:

```typescript
const buffer = await videoService.downloadVideo(response.videoUrl);
```

## Логирование

Сервис логирует все важные этапы:
- Выбор провайдера
- Оптимизацию промптов
- Создание задач
- Проверку статуса
- Ошибки и предупреждения

Используйте уровень `debug` для детальной информации о запросах и ответах API.

## Миграция с предыдущей версии

Существующий код будет работать без изменений, так как:
1. Публичные методы остались прежними
2. По умолчанию используется OpenAI (если не указано иное)
3. Обратная совместимость с Kling полностью сохранена

## Troubleshooting

### OpenAI возвращает ошибку авторизации
- Проверьте `OPENAI_API_KEY_PRO` в `.env`
- Убедитесь что API key имеет доступ к Video API
- Проверьте `OPENAI_BASE_URL_PRO` (по умолчанию: `https://api.openai.com/v1`)

### Kling возвращает ошибку авторизации
- Проверьте `KLING_ACCESS_KEY` и `KLING_SECRET_KEY`
- Убедитесь что ключи активны
- Проверьте `KLING_API_URL`

### Превышено время ожидания
- OpenAI: увеличьте `maxAttempts` до 60 (10 минут)
- Kling: увеличьте `maxAttempts` до 30 (5 минут)
- Проверьте статус API провайдера

### Видео не скачивается
- Проверьте что `videoUrl` валидный
- Для OpenAI URL требуется авторизация (автоматически добавляется)
- Проверьте что видео не истекло (OpenAI URLs имеют срок действия)

