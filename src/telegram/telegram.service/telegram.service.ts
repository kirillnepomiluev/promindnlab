import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context, Markup } from 'telegraf';
import * as QRCode from 'qrcode';
import * as path from 'path';
import fetch from 'node-fetch';
import { OpenAiService } from '../../openai/openai.service/openai.service';
import { VoiceService } from '../../voice/voice.service/voice.service';
import { VideoService } from '../../video/video.service/video.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from '../../user/entities/user-profile.entity';
import { UserTokens } from '../../user/entities/user-tokens.entity';
import { TokenTransaction } from '../../user/entities/token-transaction.entity';
import { OrderIncome } from '../../user/entities/order-income.entity';
import { MainUser } from '../../external/entities/main-user.entity';
import { MainOrder } from '../../external/entities/order.entity';
import { MainOrderItem } from '../../external/entities/order-item.entity';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  // текст приветственного сообщения
  private readonly welcomeMessage = 'Привет! Я Нейролабик — твой умный и весёлый помощник. Рад знакомству и всегда готов помочь!';
  // Стоимость операций в токенах
  private readonly COST_TEXT = 1;
  private readonly COST_IMAGE = 60;
  private readonly COST_VIDEO_LITE_BASE = 220; // базовая стоимость генерации видео Лайт (за 5 секунд)
  private readonly COST_VIDEO_PRO_BASE = 1000; // базовая стоимость генерации видео Про (за 5 секунд)
  private readonly COST_VOICE_RECOGNITION = 1;
  private readonly COST_VOICE_REPLY_EXTRA = 3; // после распознавания
  // обработка документа
  private readonly COST_FILE = 2;

  // Расчет стоимости видео в зависимости от качества и длительности
  private calculateVideoCost(quality: 'lite' | 'pro', duration: number): number {
    if (quality === 'lite') {
      // Лайт: 5 сек - 220, 10 сек - 440, 15 сек - 660
      return this.COST_VIDEO_LITE_BASE * (duration / 5);
    } else {
      // Про: 5 сек - 1000, 10 сек - 2000, 15 сек - 3000
      return this.COST_VIDEO_PRO_BASE * (duration / 5);
    }
  }
  // временное хранилище для незарегистрированных пользователей,
  // которые перешли по пригласительной ссылке
  private pendingInvites = new Map<number, string>();
  // временное хранилище для запросов на генерацию видео
  private pendingVideoRequests = new Map<
    number,
    {
      prompt: string;
      imageBuffer?: Buffer;
      messageId?: number;
      duration?: number;
      quality?: 'lite' | 'pro';
      confirmationMessageId?: number;
      skipOptimization?: boolean; // пропустить оптимизацию промпта
    }
  >();
  // ссылка на основной бот компании, где проходит первоначальная регистрация
  private readonly mainBotUrl: string;

  // формирует ссылку на основной бот, добавляя id пригласителя при необходимости
  private getMainBotLink(inviterId?: string): string {
    return inviterId ? `${this.mainBotUrl}?start=${inviterId}` : this.mainBotUrl;
  }

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly openai: OpenAiService,
    private readonly voice: VoiceService,
    private readonly video: VideoService,
    private readonly cfg: ConfigService,
    @InjectRepository(UserProfile)
    private readonly profileRepo: Repository<UserProfile>,
    @InjectRepository(UserTokens)
    private readonly tokensRepo: Repository<UserTokens>,
    @InjectRepository(TokenTransaction)
    private readonly txRepo: Repository<TokenTransaction>,
    @InjectRepository(MainUser, 'mainDb')
    private readonly mainUserRepo: Repository<MainUser>,
    @InjectRepository(MainOrder, 'mainDb')
    private readonly orderRepo: Repository<MainOrder>,
    @InjectRepository(MainOrderItem, 'mainDb')
    private readonly orderItemRepo: Repository<MainOrderItem>,
    @InjectRepository(OrderIncome)
    private readonly incomeRepo: Repository<OrderIncome>,
  ) {
    // ссылка на основной бот из переменной окружения
    this.mainBotUrl = this.cfg.get<string>('MAIN_BOT_LINK') ?? 'https://t.me/test_NLab_bot';
    this.registerHandlers();
  }

  // Поиск пользователя в основной базе.
  // Ранее здесь была проверка на диапазон 32-bit, но теперь
  // основной бот хранит идентификаторы как bigint,
  // поэтому выполняем поиск без дополнительных ограничений.
  private findMainUser(id: number): Promise<MainUser | null> {
    return this.mainUserRepo.findOne({ where: { telegramId: id } });
  }

  // Создаёт запись о движении токенов
  private async addTransaction(profile: UserProfile, amount: number, type: 'DEBIT' | 'CREDIT', comment?: string, orderIncomeId?: number) {
    const tx = this.txRepo.create({
      userId: profile.id,
      amount,
      type,
      comment,
      orderIncomeId,
    });
    await this.txRepo.save(tx);
  }
  private async sendPhoto(ctx: Context, image: string | Buffer) {
    if (Buffer.isBuffer(image)) {
      // передаём как Buffer
      await ctx.replyWithPhoto({ source: image });
    } else {
      // передаём как URL
      await ctx.replyWithPhoto(image);
    }
  }

  // отправка анимации (GIF/MP4) из папки assets/animations
  // Отправка анимации вместе с текстом и возврат полученного сообщения
  private async sendAnimation(ctx: Context, fileName: string, caption?: string) {
    const filePath = path.join(process.cwd(), 'assets', 'animations', fileName);
    // возвращаем сообщение, чтобы можно было удалить его позже
    return ctx.replyWithAnimation({ source: filePath }, caption ? { caption } : undefined);
  }

  // Отправка списка файлов пользователю
  private async sendFiles(ctx: Context, files: { filename: string; buffer: Buffer }[]) {
    for (const f of files) {
      await ctx.replyWithDocument({ source: f.buffer, filename: f.filename });
    }
  }

  // Отправка видео пользователю
  private async sendVideo(ctx: Context, videoBuffer: Buffer, caption?: string) {
    try {
      await ctx.replyWithVideo({ source: videoBuffer }, caption ? { caption } : undefined);
    } catch (error) {
      this.logger.error('Ошибка при отправке видео', error);
      // Если не удалось отправить как видео, пробуем как документ
      await ctx.replyWithDocument({ source: videoBuffer, filename: 'generated_video.mp4' });
    }
  }

  // Показать меню выбора параметров генерации видео (6 кнопок: 2 качества × 3 длительности)
  private async showVideoParametersSelection(ctx: Context, prompt: string, imageBuffer?: Buffer) {
    const message = imageBuffer
      ? `Выберите параметры генерации видео.\nВидео по фото и промпт: "${prompt}"`
      : `Выберите параметры генерации видео.\nВидео по тексту и промпт: "${prompt}"`;

    const sentMessage = await ctx.reply(
      message,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(`Лайт 5с - ${this.calculateVideoCost('lite', 5)}`, 'video_params_lite_5'),
          Markup.button.callback(`Про 5с - ${this.calculateVideoCost('pro', 5)}`, 'video_params_pro_5'),
        ],
        [
          Markup.button.callback(`Лайт 10с - ${this.calculateVideoCost('lite', 10)}`, 'video_params_lite_10'),
          Markup.button.callback(`Про 10с - ${this.calculateVideoCost('pro', 10)}`, 'video_params_pro_10'),
        ],
        [
          Markup.button.callback(`Лайт 15с - ${this.calculateVideoCost('lite', 15)}`, 'video_params_lite_15'),
          Markup.button.callback(`Про 15с - ${this.calculateVideoCost('pro', 15)}`, 'video_params_pro_15'),
        ],
      ]),
    );

    // Сохраняем запрос в временном хранилище
    this.pendingVideoRequests.set(ctx.from.id, {
      prompt,
      imageBuffer,
      messageId: sentMessage.message_id,
    });
  }

  // Показать меню выбора качества видео (старый метод для обратной совместимости)
  private async showVideoQualitySelection(ctx: Context, prompt: string, imageBuffer?: Buffer, duration?: number) {
    let message = imageBuffer
      ? `Пожалуйста, выберите качество генерации видео.\nВидео по фото и промпт: "${prompt}"`
      : `Пожалуйста, выберите качество генерации видео.\nВидео по тексту и промпт: "${prompt}"`;

    if (duration) {
      message += `\nДлительность: ${duration} секунд`;
    }

    const costLite = duration ? this.calculateVideoCost('lite', duration) : this.COST_VIDEO_LITE_BASE;
    const costPro = duration ? this.calculateVideoCost('pro', duration) : this.COST_VIDEO_PRO_BASE;

    const sentMessage = await ctx.reply(
      message,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Лайт - ${costLite} токенов`, 'video_quality_lite')],
        [Markup.button.callback(`Про - ${costPro} токенов`, 'video_quality_pro')],
      ]),
    );

    // Сохраняем запрос в временном хранилище
    this.pendingVideoRequests.set(ctx.from.id, {
      prompt,
      imageBuffer,
      messageId: sentMessage.message_id,
      duration,
    });
  }

  // Показать подтверждение списания токенов
  private async showVideoConfirmation(ctx: Context, quality: 'lite' | 'pro', messageId: number, duration?: number) {
    const request = this.pendingVideoRequests.get(ctx.from.id);
    if (!request) {
      await ctx.reply('Запрос на генерацию видео не найден. Пожалуйста, попробуйте снова.');
      return;
    }

    const { prompt } = request;
    const finalDuration = duration ?? request.duration;

    if (!finalDuration) {
      this.logger.error('Длительность не указана при показе подтверждения');
      await ctx.reply('Ошибка: длительность не указана. Пожалуйста, попробуйте снова.');
      return;
    }

    const qualityText = quality === 'pro' ? 'Про' : 'Лайт';
    const cost = this.calculateVideoCost(quality, finalDuration);
    const optimizationText = request.skipOptimization ? 'без оптимизации промпта ' : '';
    const message = `Будет сгенерировано видео ${optimizationText}"${prompt}" со следующими параметрами:\nКачество - ${qualityText}\nДлительность - ${finalDuration} секунд\n\nБудет списано: ${cost} токенов`;

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        messageId,
        undefined,
        message,
        Markup.inlineKeyboard([
          [Markup.button.callback('Отмена', 'video_cancel')],
          [Markup.button.callback('Принять', 'video_confirm')],
        ]),
      );

      // Обновляем запрос с качеством, длительностью и ID сообщения подтверждения
      this.pendingVideoRequests.set(ctx.from.id, {
        ...request,
        quality,
        duration: finalDuration,
        confirmationMessageId: messageId,
      });
    } catch (error) {
      this.logger.warn('Не удалось отредактировать сообщение с подтверждением', error);
      // Fallback: отправляем новое сообщение
      const sentMessage = await ctx.reply(
        message,
        Markup.inlineKeyboard([
          [Markup.button.callback('Отмена', 'video_cancel')],
          [Markup.button.callback('Принять', 'video_confirm')],
        ]),
      );
      this.pendingVideoRequests.set(ctx.from.id, {
        ...request,
        quality,
        duration: finalDuration,
        confirmationMessageId: sentMessage.message_id,
      });
    }
  }

  // Генерация видео с выбранным качеством
  private async generateVideoWithQuality(ctx: Context, user: UserProfile, quality: 'lite' | 'pro') {
    const request = this.pendingVideoRequests.get(ctx.from.id);
    if (!request || !request.quality) {
      await ctx.reply('Запрос на генерацию видео не найден. Пожалуйста, попробуйте снова.');
      return;
    }

    const { prompt, imageBuffer, duration } = request;
    
    if (!duration) {
      await ctx.reply('Ошибка: длительность не указана. Пожалуйста, попробуйте снова.');
      this.pendingVideoRequests.delete(ctx.from.id);
      return;
    }

    const cost = this.calculateVideoCost(quality, duration);

    // Проверяем и списываем токены
    if (!(await this.chargeTokens(ctx, user, cost))) {
      this.pendingVideoRequests.delete(ctx.from.id);
      return;
    }

    // Удаляем запрос из временного хранилища
    this.pendingVideoRequests.delete(ctx.from.id);

    const { skipOptimization } = request;

    // Отправляем сообщение об оптимизации запроса (если не пропущена оптимизация)
    const optimizeMsg = skipOptimization
      ? await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'СОЗДАЮ ВИДЕО ...')
      : await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ОПТИМИЗИРУЮ ЗАПРОС ...');

    try {
      // Генерируем видео с указанным качеством и длительностью
      const videoResult = imageBuffer
        ? await this.video.generateVideoFromImage(imageBuffer, prompt, {
            quality,
            duration,
            skipOptimization,
            onProgress: (status, attempt, maxAttempts) => {
              if (attempt === 0) {
                this.updateVideoProgress(ctx, optimizeMsg.message_id, 'СОЗДАЮ ВИДЕО', attempt, maxAttempts);
              } else {
                this.updateVideoProgress(ctx, optimizeMsg.message_id, status, attempt, maxAttempts);
              }
            },
          })
        : await this.video.generateVideo(prompt, {
            quality,
            duration,
            skipOptimization,
            onProgress: (status, attempt, maxAttempts) => {
              if (attempt === 0) {
                this.updateVideoProgress(ctx, optimizeMsg.message_id, 'СОЗДАЮ ВИДЕО', attempt, maxAttempts);
              } else {
                this.updateVideoProgress(ctx, optimizeMsg.message_id, status, attempt, maxAttempts);
              }
            },
          });

      // Удаляем сообщение с прогрессом
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, optimizeMsg.message_id);
      } catch (error) {
        this.logger.warn('Не удалось удалить сообщение с прогрессом', error);
      }

      if (videoResult.success && videoResult.videoUrl) {
        const videoBuffer = await this.video.downloadVideo(videoResult.videoUrl);
        if (videoBuffer) {
          const caption = imageBuffer ? `Видео по изображению: "${prompt}"` : `Видео по запросу: "${prompt}"`;
          await this.sendVideo(ctx, videoBuffer, caption);
        } else {
          await ctx.reply('Не удалось скачать сгенерированное видео');
        }
      } else {
        await ctx.reply(`Не удалось сгенерировать видео: ${videoResult.error}`);
      }
    } catch (error) {
      this.logger.error('Ошибка при генерации видео', error);
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, optimizeMsg.message_id);
      } catch (deleteError) {
        this.logger.warn('Не удалось удалить сообщение с прогрессом', deleteError);
      }
      await ctx.reply('Произошла ошибка при генерации видео. Попробуйте позже.');
    }
  }

  // Обновление прогресса генерации видео
  private async updateVideoProgress(ctx: Context, messageId: number, status: string, attempt: number, _maxAttempts: number) {
    try {
      const elapsedSeconds = attempt * 10;
      // Форматируем статус для отображения пользователю
      let displayStatus = status;
      
      // Проверяем, содержит ли статус процент (например "обрабатывается (55%)")
      if (status.includes('%')) {
        // Извлекаем процент из статуса
        const percentMatch = status.match(/\((\d+)%\)/);
        if (percentMatch) {
          displayStatus = `прогресс: ${percentMatch[1]}%`;
        }
      } else if (status === 'в очереди' || status.includes('queued')) {
        displayStatus = 'статус: в очереди';
      } else if (status === 'обрабатывается' || status.includes('processing')) {
        displayStatus = 'статус: обрабатывается';
      } else if (status === 'отправлена' || status.includes('submitted')) {
        displayStatus = 'статус: отправлена';
      }
      
      const progressText = `СОЗДАЮ ВИДЕО ---- ${elapsedSeconds}с ---- ${displayStatus}`;
      await ctx.telegram.editMessageCaption(ctx.chat.id, messageId, undefined, progressText);
    } catch (error) {
      this.logger.error('Ошибка при обновлении прогресса видео', error);
    }
  }

  // Обновление прогресса генерации изображения
  private async updateImageProgress(ctx: Context, messageId: number, attempt: number, maxAttempts: number) {
    try {
      const elapsedSeconds = attempt * 10;
      const progressText = `РИСУЮ ---- ${elapsedSeconds}с ---- ${attempt}/${maxAttempts}`;
      await ctx.telegram.editMessageCaption(ctx.chat.id, messageId, undefined, progressText);
    } catch (error) {
      this.logger.error('Ошибка при обновлении прогресса изображения', error);
    }
  }

  // Генерация изображения с обновлением прогресса
  private async generateImageWithProgress(ctx: Context, prompt: string, progressMsg: any): Promise<string | Buffer | null> {
    const maxAttempts = 6; // максимум 1 минута ожидания (6 * 10 секунд)
    let attempts = 0;

    // Запускаем обновление прогресса каждые 10 секунд
    const progressInterval = setInterval(async () => {
      attempts++;
      if (attempts <= maxAttempts) {
        await this.updateImageProgress(ctx, progressMsg.message_id, attempts, maxAttempts);
      }
    }, 10000);

    try {
      // Генерируем изображение
      const image = await this.openai.generateImage(prompt);

      // Останавливаем обновление прогресса
      clearInterval(progressInterval);

      return image;
    } catch (error) {
      // Останавливаем обновление прогресса в случае ошибки
      clearInterval(progressInterval);
      throw error;
    }
  }

  // Генерация изображения на основе фото с обновлением прогресса
  private async generateImageFromPhotoWithProgress(
    ctx: Context,
    imageBuffer: Buffer,
    prompt: string,
    progressMsg: any,
  ): Promise<string | Buffer | null> {
    const maxAttempts = 6; // максимум 1 минута ожидания (6 * 10 секунд)
    let attempts = 0;

    // Запускаем обновление прогресса каждые 10 секунд
    const progressInterval = setInterval(async () => {
      attempts++;
      if (attempts <= maxAttempts) {
        await this.updateImageProgress(ctx, progressMsg.message_id, attempts, maxAttempts);
      }
    }, 10000);

    try {
      // Генерируем изображение на основе фото
      const image = await this.openai.generateImageFromPhoto(imageBuffer, prompt);

      // Останавливаем обновление прогресса
      clearInterval(progressInterval);

      return image;
    } catch (error) {
      // Останавливаем обновление прогресса в случае ошибки
      clearInterval(progressInterval);
      throw error;
    }
  }

  // Загрузка файла с повторными попытками на случай временных ошибок Telegram
  private async downloadFileWithRetry(url: string, attempts = 3, delayMs = 1000): Promise<Buffer> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`TG download error: ${res.status} ${res.statusText}`);
        }
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        this.logger.warn(`Не удалось скачать файл (попытка ${attempt})`, error as Error);
        if (attempt === attempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error('Не удалось скачать файл');
  }

  // Получить ФИО пользователя из основной базы для отображения
  private getFullName(user: MainUser): string {
    const parts = [] as string[];
    if (user.firstName) parts.push(user.firstName);
    if (user.lastName) parts.push(user.lastName);
    return parts.join(' ').trim() || user.username || String(user.telegramId);
  }

  /** Списывает cost токенов. При нехватке выводит сообщение о подписке/пополнении */
  private async chargeTokens(ctx: Context, profile: UserProfile, cost: number): Promise<boolean> {
    if (profile.tokens.tokens < cost) {
      if (!profile.tokens.plan) {
        await ctx.reply(
          'На Вашем балансе недостаточно токенов для генерации.\nДля продолжения работы с ботом приобретите подписку по одному из планов:\nPLUS 2000 рублей - 1000 токенов,\nPRO 5000 рублей - 3500 токенов',
          Markup.inlineKeyboard([
            Markup.button.url('PLUS', `${this.mainBotUrl}?start=itemByID_22`),
            Markup.button.url('PRO', `${this.mainBotUrl}?start=itemByID_23`),
            Markup.button.callback('оплачено', 'payment_done'),
          ]),
        );
      } else {
        const price = profile.tokens.plan === 'PLUS' ? 400 : 200;
        await ctx.reply(
          `На Вашем балансе недостаточно токенов для генерации.\nДля продолжения работы с ботом пополните баланс:\n${price} рублей - 1000 токенов`,
          Markup.inlineKeyboard([
            Markup.button.url('пополнить', `${this.mainBotUrl}?start=itemByID_24`),
            Markup.button.callback('оплачено', 'payment_done'),
          ]),
        );
      }
      return false;
    }
    profile.tokens.tokens -= cost;
    await this.tokensRepo.save(profile.tokens);
    await this.addTransaction(profile, cost, 'DEBIT');
    return true;
  }

  /**
   * Создание профиля при отсутствии в локальной базе
   */
  private async findOrCreateProfile(
    from: { id: number; first_name?: string; username?: string },
    invitedBy?: string,
    ctx?: Context,
  ): Promise<UserProfile> {
    let profile = await this.profileRepo.findOne({
      where: { telegramId: String(from.id) },
      relations: ['tokens'],
    });

    const now = new Date();
    let isNew = false;
    if (!profile) {
      const mainUser = await this.findMainUser(from.id);
      profile = this.profileRepo.create({
        telegramId: String(from.id),
        firstName: mainUser?.firstName ?? from.first_name,
        username: mainUser?.username ?? from.username,
        firstVisitAt: now,
        lastMessageAt: now,
        invitedBy,
      });
      profile = await this.profileRepo.save(profile);

      isNew = true;

      let tokens = this.tokensRepo.create({ userId: profile.id });
      tokens = await this.tokensRepo.save(tokens);
      profile.userTokensId = tokens.id;
      await this.profileRepo.save(profile);
      profile.tokens = tokens;
      await this.addTransaction(profile, tokens.tokens, 'CREDIT', 'initial balance');
    } else {
      profile.lastMessageAt = now;
      await this.profileRepo.save(profile);
      if (!profile.tokens) {
        profile.tokens = await this.tokensRepo.findOne({ where: { userId: profile.id } });
      }
    }

    if (!profile.tokens) {
      let tokens = this.tokensRepo.create({ userId: profile.id });
      tokens = await this.tokensRepo.save(tokens);
      profile.userTokensId = tokens.id;
      await this.profileRepo.save(profile);
      profile.tokens = tokens;
      await this.addTransaction(profile, tokens.tokens, 'CREDIT', 'initial balance');
    }

    if (isNew && ctx) {
      await this.sendAnimation(ctx, 'cute_a.mp4', this.welcomeMessage);
    }

    return profile;
  }

  /**
   * Проверяет наличие пользователя в БД и при необходимости создаёт профиль.
   * Возвращает профиль или null, если пользователь не подтвердил приглашение.
   */
  private async ensureUser(ctx: Context): Promise<UserProfile | null> {
    const from = ctx.message.from;
    // пробуем найти пользователя в локальной базе
    let profile = await this.profileRepo.findOne({
      where: { telegramId: String(from.id) },
      relations: ['tokens'],
    });

    if (!profile) {
      // если его нет, ищем в основной базе
      const mainUser = await this.findMainUser(from.id);
      if (!mainUser) {
        const inviterId = this.pendingInvites.get(from.id);
        const link = this.getMainBotLink(inviterId);
        await ctx.reply(`Сначала зарегистрируйтесь в основном боте компании по ссылке: ${link}`);
        return null;
      }

      profile = await this.findOrCreateProfile(from, mainUser.whoInvitedId ? String(mainUser.whoInvitedId) : undefined, ctx);
    } else {
      profile = await this.findOrCreateProfile(from, undefined, ctx);
    }

    if (profile.subscriptionUntil && profile.subscriptionUntil.getTime() <= Date.now()) {
      if (profile.tokens.plan) {
        profile.tokens.plan = null;
        await this.tokensRepo.save(profile.tokens);
      }
      await ctx.reply(
        'Срок действия подписки истёк. Для продолжения работы с ботом приобретите подписку по одному из планов:\nPLUS 2000 рублей - 1000 токенов,\nPRO 5000 рублей - 3500 токенов',
        Markup.inlineKeyboard([
          Markup.button.url('PLUS', `${this.mainBotUrl}?start=itemByID_22`),
          Markup.button.url('PRO', `${this.mainBotUrl}?start=itemByID_23`),
          Markup.button.callback('оплачено', 'payment_done'),
        ]),
      );
      return null;
    }

    return profile;
  }

  private async processOpenAiRequest(ctx: Context, q: string, user: UserProfile, thinkingMsg: any) {
    try {
      const answer = await this.openai.chat(q, ctx.message.from.id);
      await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);

      // Обработка команды /vid promt [длительность] [качество] [описание] (без оптимизации)
      if (answer.text.startsWith('/vid promt ') || answer.text.startsWith('/vid prompt ')) {
        const parts = answer.text.replace('/vid promt ', '').replace('/vid prompt ', '').trim().split(/\s+/);
        if (parts.length < 2) {
          await ctx.reply('Использование: /vid promt [длительность] [качество] [описание]\nПример: /vid promt 15 lite Кот играет');
          return;
        }

        const durationStr = parts[0];
        const qualityStr = parts[1].toLowerCase();
        const prompt = parts.slice(2).join(' ');

        const duration = parseInt(durationStr, 10);
        if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
          await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
          return;
        }

        if (qualityStr !== 'lite' && qualityStr !== 'pro') {
          await ctx.reply('Качество должно быть "lite" или "pro"');
          return;
        }

        if (!prompt) {
          await ctx.reply('Пожалуйста, укажите описание для генерации видео');
          return;
        }

        // Сохраняем запрос и показываем сообщение для последующего редактирования
        const sentMessage = await ctx.reply('Загрузка...');
        this.pendingVideoRequests.set(ctx.from.id, {
          prompt,
          messageId: sentMessage.message_id,
          duration,
          quality: qualityStr as 'lite' | 'pro',
          skipOptimization: true,
        });
        await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
        return;
      }

      // Обработка команды /vid [длительность] [качество] [описание]
      if (answer.text.startsWith('/vid ')) {
        const parts = answer.text.replace('/vid ', '').trim().split(/\s+/);
        if (parts.length < 2) {
          await ctx.reply('Использование: /vid [длительность] [качество] [описание]\nПример: /vid 15 lite Кот играет');
          return;
        }

        const durationStr = parts[0];
        const qualityStr = parts[1].toLowerCase();
        const prompt = parts.slice(2).join(' ');

        const duration = parseInt(durationStr, 10);
        if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
          await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
          return;
        }

        if (qualityStr !== 'lite' && qualityStr !== 'pro') {
          await ctx.reply('Качество должно быть "lite" или "pro"');
          return;
        }

        if (!prompt) {
          await ctx.reply('Пожалуйста, укажите описание для генерации видео');
          return;
        }

        // Сохраняем запрос и показываем сообщение для последующего редактирования
        const sentMessage = await ctx.reply('Загрузка...');
        this.pendingVideoRequests.set(ctx.from.id, {
          prompt,
          messageId: sentMessage.message_id,
          duration,
          quality: qualityStr as 'lite' | 'pro',
        });
        await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
        return;
      }

      // Проверяем команды с длительностью /video5, /video10, /video15
      let duration: number | undefined;
      let videoCommand = answer.text;
      if (answer.text.startsWith('/video5')) {
        duration = 5;
        videoCommand = answer.text.replace('/video5', '').trim();
      } else if (answer.text.startsWith('/video10')) {
        duration = 10;
        videoCommand = answer.text.replace('/video10', '').trim();
      } else if (answer.text.startsWith('/video15')) {
        duration = 15;
        videoCommand = answer.text.replace('/video15', '').trim();
      } else if (answer.text.startsWith('/video')) {
        videoCommand = answer.text.replace('/video', '').trim();
      } else if (answer.text.startsWith('/в5')) {
        duration = 5;
        videoCommand = answer.text.replace('/в5', '').trim();
      } else if (answer.text.startsWith('/в10')) {
        duration = 10;
        videoCommand = answer.text.replace('/в10', '').trim();
      } else if (answer.text.startsWith('/в15')) {
        duration = 15;
        videoCommand = answer.text.replace('/в15', '').trim();
      } else if (answer.text.startsWith('/в')) {
        videoCommand = answer.text.replace('/в', '').trim();
      }

      if (videoCommand !== answer.text) {
        if (!videoCommand) {
          await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды');
          return;
        }
        // Если указана длительность, показываем выбор качества (2 кнопки)
        // Если длительность не указана, показываем выбор параметров (6 кнопок)
        if (duration) {
          await this.showVideoQualitySelection(ctx, videoCommand, undefined, duration);
        } else {
          await this.showVideoParametersSelection(ctx, videoCommand);
        }
      } else if (answer.text.startsWith('/imagine')) {
        if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
        const drawMsg = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
        const prompt = answer.text.replace('/imagine', '').trim();
        const image = await this.generateImageWithProgress(ctx, prompt, drawMsg);
        await ctx.telegram.deleteMessage(ctx.chat.id, drawMsg.message_id);
        if (image) {
          await this.sendPhoto(ctx, image);
        } else {
          await ctx.reply('Не удалось сгенерировать изображение');
        }
      } else {
        if (!(await this.chargeTokens(ctx, user, this.COST_TEXT))) return;
        await ctx.reply(answer.text);
      }
      if (answer.files.length) {
        await this.sendFiles(ctx, answer.files);
      }
    } catch (error) {
      // Удаляем сообщение "ДУМАЮ" в случае ошибки
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
      } catch (deleteError) {
        this.logger.warn('Не удалось удалить сообщение "ДУМАЮ"', deleteError);
      }

      // Проверяем, является ли это ошибкой занятого треда
      if (error instanceof Error && error.message.includes('Тред уже занят')) {
        await ctx.reply('⏳ Тред уже занят другим запросом. Пожалуйста, дождитесь завершения предыдущего запроса.');
      } else {
        // Для других ошибок логируем и отправляем общее сообщение
        this.logger.error('Ошибка при обработке запроса OpenAI', error);
        await ctx.reply('Произошла ошибка при обработке вашего запроса. Попробуйте позже.');
      }
      return; // Выходим из обработки, так как произошла ошибка
    }
  }

  private registerHandlers() {
    this.bot.on('text', async (ctx, next) => {
      try {
        const q = ctx.message.text?.trim();
        if (q?.startsWith('/start')) {
          return next();
        }
        const user = await this.ensureUser(ctx);
        if (!user) return;
        if (!q) return;

        // пропускаем другие команды, кроме '/image', '/video', '/vid', чтобы они обработались далее
        if (
          q.startsWith('/') &&
          !q.startsWith('/image') &&
          !q.startsWith('/и') &&
          !q.startsWith('/imagine') &&
          !q.startsWith('/video') &&
          !q.startsWith('/vid') &&
          !q.startsWith('/в')
        ) {
          return next();
        }

        // Обработка команды /vid promt [длительность] [качество] [описание] (без оптимизации)
        if (q.startsWith('/vid promt ') || q.startsWith('/vid prompt ')) {
          const parts = q.replace('/vid promt ', '').replace('/vid prompt ', '').trim().split(/\s+/);
          if (parts.length < 2) {
            await ctx.reply('Использование: /vid promt [длительность] [качество] [описание]\nПример: /vid promt 15 lite Кот играет');
            return;
          }

          const durationStr = parts[0];
          const qualityStr = parts[1].toLowerCase();
          const prompt = parts.slice(2).join(' ');

          const duration = parseInt(durationStr, 10);
          if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
            await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
            return;
          }

          if (qualityStr !== 'lite' && qualityStr !== 'pro') {
            await ctx.reply('Качество должно быть "lite" или "pro"');
            return;
          }

          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео');
            return;
          }

          // Сохраняем запрос и показываем сообщение для последующего редактирования
          const sentMessage = await ctx.reply('Загрузка...');
          this.pendingVideoRequests.set(ctx.from.id, {
            prompt,
            messageId: sentMessage.message_id,
            duration,
            quality: qualityStr as 'lite' | 'pro',
            skipOptimization: true,
          });
          await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
          return;
        }

        // Обработка команды /vid [длительность] [качество] [описание]
        // Примеры: /vid 15 lite Кот играет, /vid 5 pro Дракон летит
        if (q.startsWith('/vid ')) {
          const parts = q.replace('/vid ', '').trim().split(/\s+/);
          if (parts.length < 2) {
            await ctx.reply('Использование: /vid [длительность] [качество] [описание]\nПример: /vid 15 lite Кот играет');
            return;
          }

          const durationStr = parts[0];
          const qualityStr = parts[1].toLowerCase();
          const prompt = parts.slice(2).join(' ');

          const duration = parseInt(durationStr, 10);
          if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
            await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
            return;
          }

          if (qualityStr !== 'lite' && qualityStr !== 'pro') {
            await ctx.reply('Качество должно быть "lite" или "pro"');
            return;
          }

          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео');
            return;
          }

          // Сохраняем запрос и показываем сообщение для последующего редактирования
          const sentMessage = await ctx.reply('Загрузка...');
          this.pendingVideoRequests.set(ctx.from.id, {
            prompt,
            messageId: sentMessage.message_id,
            duration,
            quality: qualityStr as 'lite' | 'pro',
          });
          await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
          return;
        }

        // Проверяем команды с длительностью /в5, /в10, /в15
        let duration: number | undefined;
        let prompt: string;
        if (q.startsWith('/в5')) {
          duration = 5;
          prompt = q.replace('/в5', '').trim();
        } else if (q.startsWith('/в10')) {
          duration = 10;
          prompt = q.replace('/в10', '').trim();
        } else if (q.startsWith('/в15')) {
          duration = 15;
          prompt = q.replace('/в15', '').trim();
        } else if (q.startsWith('/video5')) {
          duration = 5;
          prompt = q.replace('/video5', '').trim();
        } else if (q.startsWith('/video10')) {
          duration = 10;
          prompt = q.replace('/video10', '').trim();
        } else if (q.startsWith('/video15')) {
          duration = 15;
          prompt = q.replace('/video15', '').trim();
        } else if (q.startsWith('/video') || q.startsWith('/в')) {
          prompt = q.replace('/video', '').replace('/в', '').trim();
        } else {
          prompt = '';
        }

        if (prompt !== '' || q.startsWith('/video') || q.startsWith('/в')) {
          // Если команда /в без промпта, показываем 6 кнопок
          if ((q.startsWith('/в') || q.startsWith('/video')) && !prompt && !duration) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео');
            return;
          }

          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды');
            return;
          }

          // Если указана длительность, показываем выбор качества (2 кнопки)
          // Если длительность не указана, показываем выбор параметров (6 кнопок)
          if (duration) {
            await this.showVideoQualitySelection(ctx, prompt, undefined, duration);
          } else {
            // Команда /в без указания длительности - показываем 6 кнопок
            await this.showVideoParametersSelection(ctx, prompt);
          }
        } else if (q.startsWith('/image') || q.startsWith('/и')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
          const placeholder = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
          const prompt = q.replace('/image', '').trim();
          const image = await this.generateImageWithProgress(ctx, prompt, placeholder);
          await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение');
          }
        } else {
          // Текстовый чат
          // показываем пользователю, что мы "думаем" над ответом
          const thinkingMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ДУМАЮ ...');

          // Обрабатываем запрос асинхронно, не блокируя другие сообщения
          this.processOpenAiRequest(ctx, q, user, thinkingMsg).catch((error) => {
            this.logger.error('Ошибка при асинхронной обработке OpenAI запроса', error);
          });
        }
      } catch (err) {
        this.logger.error('Ошибка обработки текстового сообщения', err);
        await ctx.reply('Произошла ошибка при обработке вашего сообщения');
      }
    });

    this.bot.on('voice', async (ctx) => {
      try {
        const user = await this.ensureUser(ctx);
        if (!user) return;
        if (!(await this.chargeTokens(ctx, user, this.COST_VOICE_RECOGNITION))) return;
        const tgVoice = ctx.message.voice;
        const listenMsg = await this.sendAnimation(ctx, 'listen_a.mp4', 'СЛУШАЮ ...');
        const text = await this.voice.voiceToText(tgVoice);
        await ctx.telegram.deleteMessage(ctx.chat.id, listenMsg.message_id);
        if (!text) return;

        const cleaned = text.trim().toLowerCase();
        if (cleaned.startsWith('создай видео') || cleaned.startsWith('video')) {
          // Показываем меню выбора параметров (6 кнопок)
          await this.showVideoParametersSelection(ctx, text);
        } else if (cleaned.startsWith('нарисуй') || cleaned.startsWith('imagine')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
          const placeholder = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
          const image = await this.generateImageWithProgress(ctx, text, placeholder);
          await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение по голосовому сообщению');
          }
        } else {
          const thinkingMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ДУМАЮ ...');

          try {
            const answer = await this.openai.chat(text, ctx.message.from.id);

            // Удаляем сообщение "ДУМАЮ" только после успешного получения ответа
            await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);

            // Обработка команды /vid promt [длительность] [качество] [описание] (без оптимизации)
            if (answer.text.startsWith('/vid promt ') || answer.text.startsWith('/vid prompt ')) {
              const parts = answer.text.replace('/vid promt ', '').replace('/vid prompt ', '').trim().split(/\s+/);
              if (parts.length < 2) {
                await ctx.reply('Использование: /vid promt [длительность] [качество] [описание]\nПример: /vid promt 15 lite Кот играет');
                return;
              }

              const durationStr = parts[0];
              const qualityStr = parts[1].toLowerCase();
              const prompt = parts.slice(2).join(' ');

              const duration = parseInt(durationStr, 10);
              if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
                await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
                return;
              }

              if (qualityStr !== 'lite' && qualityStr !== 'pro') {
                await ctx.reply('Качество должно быть "lite" или "pro"');
                return;
              }

              if (!prompt) {
                await ctx.reply('Пожалуйста, укажите описание для генерации видео');
                return;
              }

              // Сохраняем запрос и показываем сообщение для последующего редактирования
              const sentMessage = await ctx.reply('Загрузка...');
              this.pendingVideoRequests.set(ctx.from.id, {
                prompt,
                messageId: sentMessage.message_id,
                duration,
                quality: qualityStr as 'lite' | 'pro',
                skipOptimization: true,
              });
              await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
              return;
            }

            // Обработка команды /vid [длительность] [качество] [описание]
            if (answer.text.startsWith('/vid ')) {
              const parts = answer.text.replace('/vid ', '').trim().split(/\s+/);
              if (parts.length < 2) {
                await ctx.reply('Использование: /vid [длительность] [качество] [описание]\nПример: /vid 15 lite Кот играет');
                return;
              }

              const durationStr = parts[0];
              const qualityStr = parts[1].toLowerCase();
              const prompt = parts.slice(2).join(' ');

              const duration = parseInt(durationStr, 10);
              if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
                await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
                return;
              }

              if (qualityStr !== 'lite' && qualityStr !== 'pro') {
                await ctx.reply('Качество должно быть "lite" или "pro"');
                return;
              }

              if (!prompt) {
                await ctx.reply('Пожалуйста, укажите описание для генерации видео');
                return;
              }

              // Сохраняем запрос и показываем сообщение для последующего редактирования
              const sentMessage = await ctx.reply('Загрузка...');
              this.pendingVideoRequests.set(ctx.from.id, {
                prompt,
                messageId: sentMessage.message_id,
                duration,
                quality: qualityStr as 'lite' | 'pro',
              });
              await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
              return;
            }

            // Проверяем команды с длительностью
            let duration: number | undefined;
            let videoCommand = answer.text;
            if (answer.text.startsWith('/video5')) {
              duration = 5;
              videoCommand = answer.text.replace('/video5', '').trim();
            } else if (answer.text.startsWith('/video10')) {
              duration = 10;
              videoCommand = answer.text.replace('/video10', '').trim();
            } else if (answer.text.startsWith('/video15')) {
              duration = 15;
              videoCommand = answer.text.replace('/video15', '').trim();
            } else if (answer.text.startsWith('/video')) {
              videoCommand = answer.text.replace('/video', '').trim();
            } else if (answer.text.startsWith('/в5')) {
              duration = 5;
              videoCommand = answer.text.replace('/в5', '').trim();
            } else if (answer.text.startsWith('/в10')) {
              duration = 10;
              videoCommand = answer.text.replace('/в10', '').trim();
            } else if (answer.text.startsWith('/в15')) {
              duration = 15;
              videoCommand = answer.text.replace('/в15', '').trim();
            } else if (answer.text.startsWith('/в')) {
              videoCommand = answer.text.replace('/в', '').trim();
            }

            if (videoCommand !== answer.text) {
              if (!videoCommand) {
                await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды');
                return;
              }
              // Если указана длительность, показываем выбор качества (2 кнопки)
              // Если длительность не указана, показываем выбор параметров (6 кнопок)
              if (duration) {
                await this.showVideoQualitySelection(ctx, videoCommand, undefined, duration);
              } else {
                await this.showVideoParametersSelection(ctx, videoCommand);
              }
            } else if (answer.text.startsWith('/imagine')) {
              if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
              const drawMsg = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
              const prompt = answer.text.replace('/imagine', '').trim();
              const image = await this.generateImageWithProgress(ctx, prompt, drawMsg);
              await ctx.telegram.deleteMessage(ctx.chat.id, drawMsg.message_id);
              if (image) {
                await this.sendPhoto(ctx, image);
              } else {
                await ctx.reply('Не удалось сгенерировать изображение');
              }
            } else {
              if (!(await this.chargeTokens(ctx, user, this.COST_VOICE_REPLY_EXTRA))) return;
              const recordMsg = await this.sendAnimation(ctx, 'play_a.mp4', 'ЗАПИСЫВАЮ ...');
              const ogg = await this.voice.textToSpeech(answer.text);
              await ctx.telegram.deleteMessage(ctx.chat.id, recordMsg.message_id);
              try {
                await ctx.replyWithVoice({ source: ogg });
              } catch (err) {
                this.logger.warn('Голосовые сообщения запрещены', err);
                await ctx.reply(answer.text);
              }
            }
            if (answer.files.length) {
              await this.sendFiles(ctx, answer.files);
            }
          } catch (error) {
            // Удаляем сообщение "ДУМАЮ" в случае ошибки
            try {
              await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
            } catch (deleteError) {
              this.logger.warn('Не удалось удалить сообщение "ДУМАЮ"', deleteError);
            }

            // Проверяем, является ли это ошибкой занятого треда
            if (error instanceof Error && error.message.includes('Тред уже занят')) {
              await ctx.reply('⏳ Тред уже занят другим запросом. Пожалуйста, дождитесь завершения предыдущего запроса.');
            } else {
              // Для других ошибок логируем и отправляем общее сообщение
              this.logger.error('Ошибка при обработке голосового запроса OpenAI', error);
              await ctx.reply('Произошла ошибка при обработке вашего голосового запроса. Попробуйте позже.');
            }
            return; // Выходим из обработки, так как произошла ошибка
          }
        }
      } catch (err) {
        this.logger.error('Ошибка обработки голосового сообщения', err);
        await ctx.reply('Произошла ошибка при обработке вашего голосового сообщения');
      }
    });

    // обработка изображений, отправленных пользователем
    this.bot.on('photo', async (ctx) => {
      try {
        const caption = ctx.message.caption?.trim() ?? '';
        const user = await this.ensureUser(ctx);
        if (!user) return;

        const photos = ctx.message.photo;
        const best = photos[photos.length - 1];
        const link = await ctx.telegram.getFileLink(best.file_id);
        // скачиваем изображение с повторными попытками, чтобы избежать ошибок 502
        const buffer = await this.downloadFileWithRetry(link.href);

        if (caption.startsWith('/image') || caption.startsWith('/и')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
          const drawMsg = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
          const prompt = caption.replace('/image', '').trim();
          const image = await this.generateImageFromPhotoWithProgress(ctx, buffer, prompt, drawMsg);
          await ctx.telegram.deleteMessage(ctx.chat.id, drawMsg.message_id);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение');
          }
        } else if (caption.startsWith('/vid promt ') || caption.startsWith('/vid prompt ')) {
          // Обработка команды /vid promt [длительность] [качество] [описание] (без оптимизации)
          const parts = caption.replace('/vid promt ', '').replace('/vid prompt ', '').trim().split(/\s+/);
          if (parts.length < 2) {
            await ctx.reply('Использование: /vid promt [длительность] [качество] [описание]\nПример: /vid promt 15 lite Кот играет');
            return;
          }

          const durationStr = parts[0];
          const qualityStr = parts[1].toLowerCase();
          const prompt = parts.slice(2).join(' ');

          const duration = parseInt(durationStr, 10);
          if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
            await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
            return;
          }

          if (qualityStr !== 'lite' && qualityStr !== 'pro') {
            await ctx.reply('Качество должно быть "lite" или "pro"');
            return;
          }

          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео');
            return;
          }

          // Сохраняем запрос и показываем сообщение для последующего редактирования
          const sentMessage = await ctx.reply('Загрузка...');
          this.pendingVideoRequests.set(ctx.from.id, {
            prompt,
            imageBuffer: buffer,
            messageId: sentMessage.message_id,
            duration,
            quality: qualityStr as 'lite' | 'pro',
            skipOptimization: true,
          });
          await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
        } else if (caption.startsWith('/vid ')) {
          // Обработка команды /vid [длительность] [качество] [описание]
          const parts = caption.replace('/vid ', '').trim().split(/\s+/);
          if (parts.length < 2) {
            await ctx.reply('Использование: /vid [длительность] [качество] [описание]\nПример: /vid 15 lite Кот играет');
            return;
          }

          const durationStr = parts[0];
          const qualityStr = parts[1].toLowerCase();
          const prompt = parts.slice(2).join(' ');

          const duration = parseInt(durationStr, 10);
          if (isNaN(duration) || ![5, 10, 15].includes(duration)) {
            await ctx.reply('Длительность должна быть 5, 10 или 15 секунд');
            return;
          }

          if (qualityStr !== 'lite' && qualityStr !== 'pro') {
            await ctx.reply('Качество должно быть "lite" или "pro"');
            return;
          }

          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео');
            return;
          }

          // Сохраняем запрос и показываем сообщение для последующего редактирования
          const sentMessage = await ctx.reply('Загрузка...');
          this.pendingVideoRequests.set(ctx.from.id, {
            prompt,
            imageBuffer: buffer,
            messageId: sentMessage.message_id,
            duration,
            quality: qualityStr as 'lite' | 'pro',
          });
          await this.showVideoConfirmation(ctx, qualityStr as 'lite' | 'pro', sentMessage.message_id, duration);
        } else if (caption.startsWith('/video') || caption.startsWith('/в')) {
          // Проверяем команды с длительностью
          let duration: number | undefined;
          let prompt: string;
          if (caption.startsWith('/в5')) {
            duration = 5;
            prompt = caption.replace('/в5', '').trim();
          } else if (caption.startsWith('/в10')) {
            duration = 10;
            prompt = caption.replace('/в10', '').trim();
          } else if (caption.startsWith('/в15')) {
            duration = 15;
            prompt = caption.replace('/в15', '').trim();
          } else if (caption.startsWith('/video5')) {
            duration = 5;
            prompt = caption.replace('/video5', '').trim();
          } else if (caption.startsWith('/video10')) {
            duration = 10;
            prompt = caption.replace('/video10', '').trim();
          } else if (caption.startsWith('/video15')) {
            duration = 15;
            prompt = caption.replace('/video15', '').trim();
          } else {
            prompt = caption.replace('/video', '').replace('/в', '').trim();
          }

          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды');
            return;
          }
          // Если указана длительность, показываем выбор качества (2 кнопки)
          // Если длительность не указана, показываем выбор параметров (6 кнопок)
          if (duration) {
            await this.showVideoQualitySelection(ctx, prompt, buffer, duration);
          } else {
            await this.showVideoParametersSelection(ctx, prompt, buffer);
          }
        } else {
          if (!(await this.chargeTokens(ctx, user, this.COST_TEXT))) return;
          const thinkingMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ДУМАЮ ...');
          const answer = await this.openai.chatWithImage(caption, ctx.message.from.id, buffer);
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
          await ctx.reply(answer.text);
          if (answer.files.length) {
            await this.sendFiles(ctx, answer.files);
          }
        }
      } catch (err) {
        this.logger.error('Ошибка обработки фото', err);
        await ctx.reply('Произошла ошибка при обработке изображения');
      }
    });

    // обработка документов (pdf, doc и др.)
    this.bot.on('document', async (ctx) => {
      try {
        const caption = ctx.message.caption?.trim() ?? '';
        const user = await this.ensureUser(ctx);
        if (!user) return;

        const doc = ctx.message.document;
        const link = await ctx.telegram.getFileLink(doc.file_id);
        // скачиваем документ с повторными попытками, чтобы избежать ошибок сети
        const buffer = await this.downloadFileWithRetry(link.href);

        if (!(await this.chargeTokens(ctx, user, this.COST_FILE))) return;

        const thinkingMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ДУМАЮ ...');
        const answer = await this.openai.chatWithFile(caption || ' ', ctx.message.from.id, buffer, doc.file_name || 'file');
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
        await ctx.reply(answer.text);
        if (answer.files.length) {
          await this.sendFiles(ctx, answer.files);
        }
      } catch (err) {
        this.logger.error('Ошибка обработки документа', err);
        await ctx.reply('Произошла ошибка при обработке документа');
      }
    });

    this.bot.command('img', async (ctx) => {
      try {
        const user = await this.ensureUser(ctx);
        if (!user) return;
        if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
        const prompt = ctx.message.text.replace('/img', '').trim();
        const placeholder = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
        const image = await this.generateImageWithProgress(ctx, prompt, placeholder);
        await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
        if (image) {
          await this.sendPhoto(ctx, image);
        } else {
          await ctx.reply('Не удалось сгенерировать изображения');
        }
      } catch (err) {
        this.logger.error('Ошибка команды img', err);
        await ctx.reply('Ошибка при выполнении команды /img');
      }
    });

    // команда /hello выводит приветственное сообщение
    this.bot.command('hello', async (ctx) => {
      await this.findOrCreateProfile(ctx.message.from, undefined, ctx);
      await this.sendAnimation(ctx, 'cute_a.mp4', this.welcomeMessage);
    });
    // поддерживаем вариант без слеша
    this.bot.hears(/^hello$/i, async (ctx) => {
      await this.findOrCreateProfile(ctx.message.from, undefined, ctx);
      await this.sendAnimation(ctx, 'cute_a.mp4', this.welcomeMessage);
    });

    // общая функция-обработчик команды /profile и текста "profile"
    const profileHandler = async (ctx: Context) => {
      const profile = await this.findOrCreateProfile(ctx.message.from, undefined, ctx);
      if (profile.subscriptionUntil && profile.subscriptionUntil.getTime() <= Date.now()) {
        if (profile.tokens.plan) {
          profile.tokens.plan = null;
          await this.tokensRepo.save(profile.tokens);
        }
        await ctx.reply(
          'Срок действия подписки истёк. Для продолжения работы с ботом приобретите подписку по одному из планов:\nPLUS 2000 рублей - 1000 токенов,\nPRO 5000 рублей - 3500 токенов',
          Markup.inlineKeyboard([
            Markup.button.url('PLUS', `${this.mainBotUrl}?start=itemByID_22`),
            Markup.button.url('PRO', `${this.mainBotUrl}?start=itemByID_23`),
            Markup.button.callback('оплачено', 'payment_done'),
          ]),
        );
        return;
      }
      const main = await this.findMainUser(Number(profile.telegramId));

      const userParts = [] as string[];
      if (main?.firstName || profile.firstName) userParts.push(main?.firstName ?? profile.firstName);
      if (main?.lastName) userParts.push(main.lastName);
      if (main?.username || profile.username) userParts.push(main?.username ?? profile.username);
      const userInfo = userParts.join(' ').trim();

      let sponsorInfo = 'не указан';
      if (main?.telegramIdOfReferall) {
        const sponsor = await this.findMainUser(Number(main.telegramIdOfReferall));
        if (sponsor) {
          const sponsorParts = [] as string[];
          if (sponsor.firstName) sponsorParts.push(sponsor.firstName);
          if (sponsor.lastName) sponsorParts.push(sponsor.lastName);
          if (sponsor.username) sponsorParts.push(sponsor.username);
          sponsorInfo = sponsorParts.join(' ').trim() || sponsorInfo;
        }
      }

      const plan = profile.tokens.plan ?? 'нет';
      let until = '';
      if (profile.tokens.plan && profile.subscriptionUntil) {
        until = ' до ' + profile.subscriptionUntil.toLocaleDateString('ru-RU');
      }

      const message =
        `Данные пользователя: <b>${userInfo}</b>\n` +
        `Данные спонсора: <b>${sponsorInfo}</b>\n` +
        `Текущий тарифный план: <b>${plan}</b>${until}\n` +
        `Ваш баланс: <b>${profile.tokens.tokens} токенов</b>\n\n` +
        `📋 <b>Инструкция по использованию:</b>\n\n` +
        `🎨 <b>Генерация изображений:</b>\n` +
        `• Команда: <code>/и [описание]</code>\n` +
        `• Пример: <code>/и красивая кошка</code>\n` +
        `• Стоимость: <b>${this.COST_IMAGE} токенов</b>\n\n` +
        `🎬 <b>Генерация видео:</b>\n` +
        `• Команда: <code>/в [описание]</code>\n` +
        `• Пример: <code>/в кошка играет с мячиком</code>\n` +
        `• Стоимость Лайт: <b>5с - ${this.calculateVideoCost('lite', 5)}, 10с - ${this.calculateVideoCost('lite', 10)}, 15с - ${this.calculateVideoCost('lite', 15)} токенов</b>\n` +
        `• Стоимость Про: <b>5с - ${this.calculateVideoCost('pro', 5)}, 10с - ${this.calculateVideoCost('pro', 10)}, 15с - ${this.calculateVideoCost('pro', 15)} токенов</b>\n\n` +
        `🎵 <b>Работа с аудио:</b>\n` +
        `• Распознавание речи: <b>${this.COST_VOICE_RECOGNITION} токен</b>\n` +
        `• Генерация ответа: <b>${this.COST_VOICE_REPLY_EXTRA} токена</b>\n\n` +
        `📄 <b>Обработка документов:</b>\n` +
        `• Стоимость: <b>${this.COST_FILE} токена</b>\n\n` +
        `💬 <b>Текстовые запросы:</b>\n` +
        `• Стоимость: <b>${this.COST_TEXT} токен</b>`;

      await ctx.reply(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([Markup.button.callback('Получить ссылку', 'invite_link')]),
      });
    };

    // команда для просмотра баланса и получения пригласительной ссылки
    this.bot.command('profile', profileHandler);
    // поддерживаем вариант без слеша
    this.bot.hears(/^profile$/i, profileHandler);

    // обработка перехода по ссылке с кодом
    this.bot.start(async (ctx) => {
      // ctx.startPayload помечен как устаревший,
      // поэтому при необходимости извлекаем код из текста сообщения
      const payload = ctx.startPayload ?? (ctx.message && 'text' in ctx.message ? ctx.message.text.replace('/start', '').trim() : undefined);
      const exists = await this.profileRepo.findOne({
        where: { telegramId: String(ctx.from.id) },
      });
      if (exists) {
        await ctx.reply('Вы уже зарегистрированы');
        return;
      }

      if (!payload) {
        await ctx.reply('Пожалуйста, перейдите по пригласительной ссылке.');
        return;
      }

      this.pendingInvites.set(ctx.from.id, payload);
      const inviter = await this.findMainUser(Number(payload));
      if (!inviter) {
        await ctx.reply('Пригласитель не найден.');
        return;
      }

      await ctx.reply(
        `Вас пригласил пользователь - ${this.getFullName(inviter)}. Вы подтверждаете?`,
        Markup.inlineKeyboard([Markup.button.callback('Подтвердить', `confirm:${payload}`)]),
      );
    });

    // подтверждение приглашения и создание профиля
    this.bot.action(/^confirm:(.+)/, async (ctx) => {
      const inviterId = ctx.match[1];
      const mainUser = await this.findMainUser(ctx.from.id);
      if (!mainUser) {
        const link = this.getMainBotLink(inviterId);
        await ctx.editMessageText(`Сначала зарегистрируйтесь в основном боте компании по ссылке: ${link}`);
        return;
      }

      await this.findOrCreateProfile(ctx.from, inviterId, ctx);
      this.pendingInvites.delete(ctx.from.id);
      await ctx.editMessageText('Регистрация завершена');
    });

    this.bot.action('invite_link', async (ctx) => {
      await ctx.answerCbQuery();

      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      const inviteLink = `${this.mainBotUrl}?start=${profile.telegramId}`;

      const qr = await QRCode.toBuffer(inviteLink);
      // Отправляем QR-код и текст с ссылкой одним сообщением
      await ctx.replyWithPhoto({ source: qr }, { caption: `Пригласительная ссылка: ${inviteLink}` });
    });

    // оформление подписки
    this.bot.action(['subscribe_PLUS', 'subscribe_PRO'], async (ctx) => {
      await ctx.answerCbQuery();
      const data = (ctx.callbackQuery as any).data as string;
      const plan = data === 'subscribe_PLUS' ? 'PLUS' : 'PRO';

      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);

      const mainUser = await this.findMainUser(Number(profile.telegramId));
      if (!mainUser) {
        await ctx.reply('вы не авторизованы, получите приглашение у своего спонсора');
        return;
      }

      profile.tokens.pendingPayment = plan as 'PLUS' | 'PRO';
      await this.tokensRepo.save(profile.tokens);

      await ctx.editMessageText(
        `Перейдите в Основной бот компании Нейролаб для оплаты подписки ${plan}`,
        Markup.inlineKeyboard([Markup.button.callback('Открыть', `open_pay_${plan}`)]),
      );
    });

    this.bot.action(/^open_pay_(PLUS|PRO)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const plan = ctx.match[1] as 'PLUS' | 'PRO';

      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);

      const mainUser = await this.findMainUser(Number(profile.telegramId));
      if (!mainUser) {
        await ctx.reply('вы не авторизованы, получите приглашение у своего спонсора');
        return;
      }

      if (profile.tokens.pendingPayment !== plan) {
        profile.tokens.pendingPayment = plan;
        await this.tokensRepo.save(profile.tokens);
      }

      const order = this.orderRepo.create({
        status: 'Pending',
        totalAmount: plan === 'PLUS' ? 2000 : 5000,
        totalPoints: 1,
        userId: mainUser.id,
      });
      await this.orderRepo.save(order);

      const botLink = `${this.mainBotUrl}?start=pay_${plan}`;
      await ctx.editMessageText(
        `Перейдите в Основной бот НейроЛаб для оплаты подписки ${plan}`,
        Markup.inlineKeyboard([Markup.button.url('Открыть', botLink), Markup.button.callback('Я оплатил', `paid_${plan}`)]),
      );
    });

    // пополнение баланса по активной подписке
    this.bot.action('topup', async (ctx) => {
      await ctx.answerCbQuery();
      const link = 'https://img.rl0.ru/afisha/e1000x500i/daily.afisha.ru/uploads/images/3/1d/31d91ff715902c15bde808052fa02154.png';
      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      profile.tokens.pendingPayment = 'TOPUP';
      await this.tokensRepo.save(profile.tokens);

      await ctx.reply(
        `Перейдите по ссылке для пополнения баланса: ${link}`,
        Markup.inlineKeyboard([Markup.button.callback('Я оплатил', 'paid_TOPUP')]),
      );
    });

    // подтверждение оплаты
    this.bot.action(['paid_PLUS', 'paid_PRO', 'paid_TOPUP'], async (ctx) => {
      await ctx.answerCbQuery();
      const data = (ctx.callbackQuery as any).data as string;
      const type = data.replace('paid_', '').toUpperCase();
      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      if (!profile.tokens.pendingPayment || profile.tokens.pendingPayment !== type) {
        await ctx.reply('Нет ожидаемого платежа.');
        return;
      }
      profile.tokens.pendingPayment = null;
      if (type === 'PLUS' || type === 'PRO') {
        profile.tokens.plan = type as 'PLUS' | 'PRO';
        const add = type === 'PLUS' ? 1000 : 3500;
        profile.tokens.tokens += add;
        const now = new Date();
        const until = new Date(now);
        until.setDate(until.getDate() + 30);
        profile.tokens.dateSubscription = now;
        profile.tokens.subscriptionUntil = until;
        profile.dateSubscription = now;
        profile.subscriptionUntil = until;
        await this.tokensRepo.save(profile.tokens);
        await this.profileRepo.save(profile);
        await this.addTransaction(profile, add, 'CREDIT', `subscription ${type}`);
        await ctx.editMessageText(`Поздравляем с подпиской ${type}!`);
      } else {
        const add = 1000;
        profile.tokens.tokens += add;
        await this.tokensRepo.save(profile.tokens);
        await this.addTransaction(profile, add, 'CREDIT', 'balance topup');
        await ctx.editMessageText('На ваш счёт зачислено 1000 бонусов');
      }
    });

    // проверка оплаченных заказов в основной БД
    this.bot.action('payment_done', async (ctx) => {
      await ctx.answerCbQuery();
      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      const mainUser = await this.findMainUser(Number(profile.telegramId));
      if (!mainUser) {
        await ctx.reply('вы не авторизованы, получите приглашение у спонсора');
        return;
      }

      const orders = await this.orderRepo.find({
        where: { userId: mainUser.id, promind: true },
      });
      let processed = 0;
      for (const order of orders) {
        const exists = await this.incomeRepo.findOne({
          where: { mainOrderId: order.id },
        });
        if (exists) continue;

        const items = await this.orderItemRepo.find({
          where: { orderId: order.id },
          relations: ['item'],
        });
        if (items.length === 0) continue;

        const income = await this.incomeRepo.save(this.incomeRepo.create({ mainOrderId: order.id, userId: mainUser.id }));

        let add = 0;
        let isSubscription = false;
        for (const orderItem of items) {
          const action = (orderItem.item?.promindAction || '').toLowerCase();
          if (action === 'plus') {
            add += 1000;
            profile.tokens.plan = 'PLUS';
            isSubscription = true;
          } else if (action === 'pro') {
            add += 3500;
            profile.tokens.plan = 'PRO';
            isSubscription = true;
          } else if (action === 'tokens') {
            add += 1000;
          }
        }

        if (add === 0) continue;

        const now = new Date();
        if (isSubscription) {
          const until = new Date(now);
          until.setDate(until.getDate() + 30);
          profile.tokens.dateSubscription = now;
          profile.tokens.subscriptionUntil = until;
          profile.dateSubscription = now;
          profile.subscriptionUntil = until;
        }

        profile.tokens.tokens += add;
        await this.tokensRepo.save(profile.tokens);
        await this.profileRepo.save(profile);

        await this.txRepo.save(
          this.txRepo.create({
            userId: profile.id,
            amount: add,
            type: 'CREDIT',
            comment: `order ${order.id}`,
            orderIncomeId: income.id,
          }),
        );

        processed++;
      }

      if (processed > 0) {
        await ctx.reply(`Обработано заказов: ${processed}`);
      } else {
        await ctx.reply('Новых оплаченных заказов не найдено');
      }
    });

    // Обработка выбора параметров видео (6 кнопок: качество + длительность)
    this.bot.action(/^video_params_(lite|pro)_(5|10|15)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      if (!user) return;

      const match = ctx.match;
      const quality = match[1] as 'lite' | 'pro';
      const duration = parseInt(match[2], 10);

      const messageId = ctx.callbackQuery.message && 'message_id' in ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : undefined;
      if (!messageId) {
        await ctx.reply('Ошибка: не удалось получить ID сообщения');
        return;
      }

      await this.showVideoConfirmation(ctx, quality, messageId, duration);
    });

    // Обработка выбора качества видео (старые обработчики для обратной совместимости)
    this.bot.action('video_quality_lite', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      if (!user) return;

      const messageId = ctx.callbackQuery.message && 'message_id' in ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : undefined;
      if (!messageId) {
        await ctx.reply('Ошибка: не удалось получить ID сообщения');
        return;
      }

      await this.showVideoConfirmation(ctx, 'lite', messageId);
    });

    this.bot.action('video_quality_pro', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      if (!user) return;

      const messageId = ctx.callbackQuery.message && 'message_id' in ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : undefined;
      if (!messageId) {
        await ctx.reply('Ошибка: не удалось получить ID сообщения');
        return;
      }

      await this.showVideoConfirmation(ctx, 'pro', messageId);
    });

    // Обработка подтверждения генерации видео
    this.bot.action('video_confirm', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      if (!user) return;

      const request = this.pendingVideoRequests.get(ctx.from.id);
      if (!request || !request.quality) {
        await ctx.reply('Запрос на генерацию видео не найден. Пожалуйста, попробуйте снова.');
        return;
      }

      // Удаляем сообщение с подтверждением (опционально, можно оставить)
      try {
        await ctx.deleteMessage();
      } catch (error) {
        this.logger.warn('Не удалось удалить сообщение с подтверждением', error);
      }

      // Вызываем генерацию с выбранным качеством
      await this.generateVideoWithQuality(ctx, user, request.quality);
    });

    // Обработка отмены генерации видео
    this.bot.action('video_cancel', async (ctx) => {
      await ctx.answerCbQuery();

      const request = this.pendingVideoRequests.get(ctx.from.id);
      if (request) {
        this.pendingVideoRequests.delete(ctx.from.id);
      }

      try {
        await ctx.editMessageText('Генерация видео отменена.');
      } catch (error) {
        this.logger.warn('Не удалось отредактировать сообщение при отмене', error);
        await ctx.reply('Генерация видео отменена.');
      }
    });

    this.bot.catch((err, ctx) => {
      this.logger.error('TG error', err);
      this.logger.debug('Update caused error', JSON.stringify(ctx.update, null, 2));
    });
  }
}
