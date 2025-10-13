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
  private readonly COST_VIDEO = 200; // стоимость генерации видео
  private readonly COST_VOICE_RECOGNITION = 1;
  private readonly COST_VOICE_REPLY_EXTRA = 3; // после распознавания
  // обработка документа
  private readonly COST_FILE = 2;
  // временное хранилище для незарегистрированных пользователей,
  // которые перешли по пригласительной ссылке
  private pendingInvites = new Map<number, string>();
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

      if (answer.text.startsWith('/video')) {
        if (!(await this.chargeTokens(ctx, user, this.COST_VIDEO))) return;
        const prompt = answer.text.replace('/video', '').trim();
        if (!prompt) {
          await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды /video');
          return;
        }

        // Отправляем сообщение об оптимизации запроса
        const optimizeMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ОПТИМИЗИРУЮ ЗАПРОС ...');

        // Генерируем видео (внутри будет оптимизация промта)
        const videoResult = await this.video.generateVideo(prompt, {
          onProgress: (status, attempt, maxAttempts) => {
            // Обновляем сообщение на "СОЗДАЮ ВИДЕО" когда начинается генерация
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
            await this.sendVideo(ctx, videoBuffer, `Видео по запросу: "${prompt}"`);
          } else {
            await ctx.reply('Не удалось скачать сгенерированное видео');
          }
        } else {
          await ctx.reply(`Не удалось сгенерировать видео: ${videoResult.error}`);
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

        // пропускаем другие команды, кроме '/image', '/video', чтобы они обработались далее
        if (
          q.startsWith('/') &&
          !q.startsWith('/image') &&
          !q.startsWith('/и') &&
          !q.startsWith('/imagine') &&
          !q.startsWith('/video') &&
          !q.startsWith('/в')
        ) {
          return next();
        }

        if (q.startsWith('/video') || q.startsWith('/в')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_VIDEO))) return;
          const prompt = q.replace('/video', '').trim();
          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды /video');
            return;
          }

          // Отправляем сообщение об оптимизации запроса
          const optimizeMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ОПТИМИЗИРУЮ ЗАПРОС ...');

          // Генерируем видео (внутри будет оптимизация промта)
          const videoResult = await this.video.generateVideo(prompt, {
            onProgress: (status, attempt, maxAttempts) => {
              // Обновляем сообщение на "СОЗДАЮ ВИДЕО" когда начинается генерация
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
              await this.sendVideo(ctx, videoBuffer, `Видео по запросу: "${prompt}"`);
            } else {
              await ctx.reply('Не удалось скачать сгенерированное видео');
            }
          } else {
            await ctx.reply(`Не удалось сгенерировать видео: ${videoResult.error}`);
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
          if (!(await this.chargeTokens(ctx, user, this.COST_VIDEO))) return;

          // Отправляем сообщение об оптимизации запроса
          const optimizeMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ОПТИМИЗИРУЮ ЗАПРОС ...');

          // Генерируем видео (внутри будет оптимизация промта)
          const videoResult = await this.video.generateVideo(text, {
            onProgress: (status, attempt, maxAttempts) => {
              // Обновляем сообщение на "СОЗДАЮ ВИДЕО" когда начинается генерация
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
              await this.sendVideo(ctx, videoBuffer, `Видео по запросу: "${text}"`);
            } else {
              await ctx.reply('Не удалось скачать сгенерированное видео');
            }
          } else {
            await ctx.reply(`Не удалось сгенерировать видео: ${videoResult.error}`);
          }
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

            if (answer.text.startsWith('/video') || answer.text.startsWith('/в')) {
              if (!(await this.chargeTokens(ctx, user, this.COST_VIDEO))) return;
              const prompt = answer.text.replace('/video', '').trim();
              if (!prompt) {
                await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды /video');
                return;
              }

              // Отправляем сообщение об оптимизации запроса
              const optimizeMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ОПТИМИЗИРУЮ ЗАПРОС ...');

              // Генерируем видео (внутри будет оптимизация промта)
              const videoResult = await this.video.generateVideo(prompt, {
                onProgress: (status, attempt, maxAttempts) => {
                  // Обновляем сообщение на "СОЗДАЮ ВИДЕО" когда начинается генерация
                  if (attempt === 0) {
                    this.updateVideoProgress(ctx, optimizeMsg.message_id, 'СОЗДАЮ ВИДЕО', attempt, maxAttempts);
                  } else {
                    this.updateVideoProgress(ctx, optimizeMsg.message_id, status, attempt, maxAttempts);
                  }
                },
              });
              if (videoResult.success && videoResult.videoUrl) {
                const videoBuffer = await this.video.downloadVideo(videoResult.videoUrl);
                if (videoBuffer) {
                  await this.sendVideo(ctx, videoBuffer, `Видео по запросу: "${text}"`);
                } else {
                  await ctx.reply('Не удалось скачать сгенерированное видео');
                }
              } else {
                await ctx.reply(`Не удалось сгенерировать видео: ${videoResult.error}`);
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
        } else if (caption.startsWith('/video') || caption.startsWith('/в')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_VIDEO))) return;
          const prompt = caption.replace('/video', '').trim();
          if (!prompt) {
            await ctx.reply('Пожалуйста, укажите описание для генерации видео после команды /video');
            return;
          }

          // Отправляем сообщение об оптимизации запроса
          const optimizeMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ОПТИМИЗИРУЮ ЗАПРОС ...');

          // Генерируем видео по изображению (внутри будет оптимизация промта)
          const videoResult = await this.video.generateVideoFromImage(buffer, prompt, {
            onProgress: (status, attempt, maxAttempts) => {
              // Обновляем сообщение на "СОЗДАЮ ВИДЕО" когда начинается генерация
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
              await this.sendVideo(ctx, videoBuffer, `Видео по изображению: "${prompt}"`);
            } else {
              await ctx.reply('Не удалось скачать сгенерированное видео');
            }
          } else {
            await ctx.reply(`Не удалось сгенерировать видео: ${videoResult.error}`);
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
        `• Стоимость: <b>${this.COST_VIDEO} токенов</b>\n\n` +
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

    this.bot.catch((err, ctx) => {
      this.logger.error('TG error', err);
      this.logger.debug('Update caused error', JSON.stringify(ctx.update, null, 2));
    });
  }
}
