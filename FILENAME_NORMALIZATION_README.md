# Нормализация имен файлов для OpenAI API

## Проблема

OpenAI API чувствителен к регистру расширений файлов. При загрузке файлов с расширениями в верхнем регистре (например, `.DOCX`, `.PDF`, `.JPG`) возникают ошибки:

```
Error: 400 Invalid extension DOCX. Supported formats: "c", "cpp", "css", "csv", "doc", "docx", "gif", "go", "html", "java", "jpeg", "jpg", "js", "json", "md", "pdf", "php", "pkl", "png", "pptx", "py", "rb", "tar", "tex", "ts", "txt", "webp", "xlsx", "xml", "zip"
```

## Решение

Добавлен метод `normalizeFilename()` в `OpenAiService`, который:

1. **Автоматически приводит расширения к нижнему регистру** - `document.DOCX` → `document.docx`
2. **Проверяет поддерживаемые форматы** - выводит предупреждение для неподдерживаемых расширений
3. **Логирует изменения** - отслеживает, когда имена файлов были изменены

## Реализация

### Метод normalizeFilename

```typescript
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
```

### Поддерживаемые форматы

```typescript
private readonly SUPPORTED_EXTENSIONS = [
  'c', 'cpp', 'css', 'csv', 'doc', 'docx', 'gif', 'go', 'html', 'java',
  'jpeg', 'jpg', 'js', 'json', 'md', 'pdf', 'php', 'pkl', 'png', 'pptx',
  'py', 'rb', 'tar', 'tex', 'ts', 'txt', 'webp', 'xlsx', 'xml', 'zip',
];
```

## Использование

Метод автоматически вызывается в `chatWithFile()`:

```typescript
async chatWithFile(
  content: string,
  userId: number,
  fileBuffer: Buffer,
  filename: string,
): Promise<OpenAiAnswer> {
  // Нормализуем имя файла
  const normalizedFilename = this.normalizeFilename(filename);
  
  // ... остальной код ...
  
  const fileObj = await toFile(fileBuffer, normalizedFilename);
  // ...
}
```

## Примеры работы

| Исходное имя | Нормализованное имя | Статус |
|--------------|---------------------|---------|
| `document.DOCX` | `document.docx` | ✅ Изменено |
| `image.JPG` | `image.jpg` | ✅ Изменено |
| `file.PDF` | `file.pdf` | ✅ Изменено |
| `text.txt` | `text.txt` | ✅ Не изменено |
| `noextension` | `noextension` | ✅ Не изменено |
| `my.file.DOCX` | `my.file.docx` | ✅ Изменено |

## Логирование

Система логирует все изменения имен файлов:

```
[Nest] INFO [OpenAiService] Нормализовано имя файла: "document.DOCX" -> "document.docx"
```

А также предупреждает о неподдерживаемых форматах:

```
[Nest] WARN [OpenAiService] Неподдерживаемое расширение файла: "xyz" для файла "file.xyz". Поддерживаемые форматы: c, cpp, css, csv, doc, docx, gif, go, html, java, jpeg, jpg, js, json, md, pdf, php, pkl, png, pptx, py, rb, tar, tex, ts, txt, webp, xlsx, xml, zip
```

## Преимущества

1. **Автоматическое исправление** - не требует изменений в пользовательском коде
2. **Обратная совместимость** - не влияет на уже корректные имена файлов
3. **Информативность** - подробное логирование для отладки
4. **Безопасность** - проверка поддерживаемых форматов
5. **Производительность** - минимальные накладные расходы

## Тестирование

Добавлены unit-тесты для проверки корректности работы:

```bash
npm test -- --testPathPattern=openai.service.spec.ts
```

Тесты покрывают все возможные сценарии:
- Конвертация верхнего регистра в нижний
- Обработка смешанного регистра
- Файлы без расширений
- Пустые и null значения
- Файлы с множественными точками
