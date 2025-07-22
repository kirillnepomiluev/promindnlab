import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context, Markup } from 'telegraf';
import * as QRCode from 'qrcode';
import * as path from 'path';
import { OpenAiService } from 'src/openai/openai.service/openai.service';
import { VoiceService } from 'src/voice/voice.service/voice.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from 'src/user/entities/user-profile.entity';
import { UserTokens } from 'src/user/entities/user-tokens.entity';
import { TokenTransaction } from 'src/user/entities/token-transaction.entity';
import { OrderIncome } from 'src/user/entities/order-income.entity';
import { MainUser } from 'src/external/entities/main-user.entity';
import { MainOrder } from 'src/external/entities/order.entity';
import { MainOrderItem } from 'src/external/entities/order-item.entity';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  // текст приветственного сообщения
  private readonly welcomeMessage = 'Привет! Я Нейролабик — твой умный и весёлый помощник. Рад знакомству и всегда готов помочь!';
  // Стоимость операций в токенах
  private readonly COST_TEXT = 1;
  private readonly COST_IMAGE = 10;
  private readonly COST_VOICE_RECOGNITION = 1;
  private readonly COST_VOICE_REPLY_EXTRA = 3; // после распознавания
  // временное хранилище для незарегистрированных пользователей,
  // которые перешли по пригласительной ссылке
  private pendingInvites = new Map<number, string>();

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly openai: OpenAiService,
    private readonly voice: VoiceService,
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
    this.registerHandlers();
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
            Markup.button.url('PLUS', 'https://t.me/test_NLab_bot?start=itemByID_22'),
            Markup.button.url('PRO', 'https://t.me/test_NLab_bot?start=itemByID_23'),
            Markup.button.callback('оплачено', 'payment_done'),
          ]),
        );
      } else {
        const price = profile.tokens.plan === 'PLUS' ? 400 : 200;
        await ctx.reply(
          `На Вашем балансе недостаточно токенов для генерации.\nДля продолжения работы с ботом пополните баланс:\n${price} рублей - 1000 токенов`,
          Markup.inlineKeyboard([
            Markup.button.url('пополнить', 'https://t.me/test_NLab_bot?start=itemByID_24'),
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
      const mainUser = await this.mainUserRepo.findOne({ where: { telegramId: from.id } });
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
      const mainUser = await this.mainUserRepo.findOne({ where: { telegramId: from.id } });
      if (!mainUser) {
        const inviterId = this.pendingInvites.get(from.id);
        if (!inviterId) {
          await ctx.reply('Пожалуйста, перейдите по пригласительной ссылке.');
          return null;
        }

        const inviter = await this.mainUserRepo.findOne({ where: { telegramId: Number(inviterId) } });
        if (!inviter) {
          await ctx.reply('Пригласитель не найден.');
          this.pendingInvites.delete(from.id);
          return null;
        }

        await ctx.reply(
          `Вас пригласил пользователь - ${this.getFullName(inviter)}. Вы подтверждаете?`,
          Markup.inlineKeyboard([Markup.button.callback('Подтвердить', `confirm:${inviterId}`)]),
        );
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
          Markup.button.url('PLUS', 'https://t.me/test_NLab_bot?start=itemByID_22'),
          Markup.button.url('PRO', 'https://t.me/test_NLab_bot?start=itemByID_23'),
          Markup.button.callback('оплачено', 'payment_done'),
        ]),
      );
      return null;
    }

    return profile;
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

        // пропускаем другие команды, кроме '/image', чтобы они обработались далее
        if (q.startsWith('/') && !q.startsWith('/image') && !q.startsWith('/imagine')) {
          return next();
        }

        if (q.startsWith('/image')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
          const placeholder = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
          const prompt = q.replace('/image', '').trim();
          const image = await this.openai.generateImage(prompt);
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
          const answer = await this.openai.chat(q, ctx.message.from.id);
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);

          if (answer.startsWith('/imagine')) {
            if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
            const drawMsg = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
            const prompt = answer.replace('/imagine', '').trim();
            const image = await this.openai.generateImage(prompt);
            await ctx.telegram.deleteMessage(ctx.chat.id, drawMsg.message_id);
            if (image) {
              await this.sendPhoto(ctx, image);
            } else {
              await ctx.reply('Не удалось сгенерировать изображение');
            }
          } else {
            if (!(await this.chargeTokens(ctx, user, this.COST_TEXT))) return;
            await ctx.reply(answer);
          }
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
        if (cleaned.startsWith('нарисуй') || cleaned.startsWith('imagine')) {
          if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
          const placeholder = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
          const image = await this.openai.generateImage(text);
          await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение по голосовому сообщению');
          }
        } else {
          const thinkingMsg = await this.sendAnimation(ctx, 'thinking_pen_a.mp4', 'ДУМАЮ ...');
          const answer = await this.openai.chat(text, ctx.message.from.id);
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
          if (answer.startsWith('/imagine')) {
            if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
            const drawMsg = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
            const prompt = answer.replace('/imagine', '').trim();
            const image = await this.openai.generateImage(prompt);
            await ctx.telegram.deleteMessage(ctx.chat.id, drawMsg.message_id);
            if (image) {
              await this.sendPhoto(ctx, image);
            } else {
              await ctx.reply('Не удалось сгенерировать изображение');
            }
          } else {
            if (!(await this.chargeTokens(ctx, user, this.COST_VOICE_REPLY_EXTRA))) return;
            const recordMsg = await this.sendAnimation(ctx, 'play_a.mp4', 'ЗАПИСЫВАЮ ...');
            const ogg = await this.voice.textToSpeech(answer);
            await ctx.telegram.deleteMessage(ctx.chat.id, recordMsg.message_id);
            try {
              await ctx.replyWithVoice({ source: ogg });
            } catch (err) {
              this.logger.warn('Голосовые сообщения запрещены', err);
              await ctx.reply(answer);
            }
          }
        }
      } catch (err) {
        this.logger.error('Ошибка обработки голосового сообщения', err);
        await ctx.reply('Произошла ошибка при обработке вашего голосового сообщения');
      }
    });

    this.bot.command('img', async (ctx) => {
      try {
        const user = await this.ensureUser(ctx);
        if (!user) return;
        if (!(await this.chargeTokens(ctx, user, this.COST_IMAGE))) return;
        const prompt = ctx.message.text.replace('/img', '').trim();
        const placeholder = await this.sendAnimation(ctx, 'drawing_a.mp4', 'РИСУЮ ...');
        const image = await this.openai.generateImage(prompt);
        await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
        if (image) {
          await this.sendPhoto(ctx, image);
        } else {
          await ctx.reply('Не удалось сгенерировать изображение');
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
            Markup.button.url('PLUS', 'https://t.me/test_NLab_bot?start=itemByID_22'),
            Markup.button.url('PRO', 'https://t.me/test_NLab_bot?start=itemByID_23'),
            Markup.button.callback('оплачено', 'payment_done'),
          ]),
        );
        return;
      }
      const main = await this.mainUserRepo.findOne({ where: { telegramId: Number(profile.telegramId) } });

      const userParts = [] as string[];
      if (main?.firstName || profile.firstName) userParts.push(main?.firstName ?? profile.firstName);
      if (main?.lastName) userParts.push(main.lastName);
      if (main?.username || profile.username) userParts.push(main?.username ?? profile.username);
      const userInfo = userParts.join(' ').trim();

      let sponsorInfo = 'не указан';
      if (main?.telegramIdOfReferall) {
        const sponsor = await this.mainUserRepo.findOne({ where: { telegramId: Number(main.telegramIdOfReferall) } });
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
        `Ваш баланс: <b>${profile.tokens.tokens} токенов</b>`;

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
      const inviter = await this.mainUserRepo.findOne({ where: { telegramId: Number(payload) } });
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
      await this.findOrCreateProfile(ctx.from, inviterId, ctx);
      this.pendingInvites.delete(ctx.from.id);
      await ctx.editMessageText('Регистрация завершена');
    });

    this.bot.action('invite_link', async (ctx) => {
      await ctx.answerCbQuery();

      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);
      const inviteLink = `https://t.me/personal_assistent_NeuroLab_bot?start=${profile.telegramId}`;

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

      const mainUser = await this.mainUserRepo.findOne({ where: { telegramId: Number(profile.telegramId) } });
      if (!mainUser) {
        await ctx.reply('вы не авторизованы, получите приглашение у своего спонсора');
        return;
      }

      profile.tokens.pendingPayment = plan as 'PLUS' | 'PRO';
      await this.tokensRepo.save(profile.tokens);

      await ctx.editMessageText(
        `Перейдите в @test_NLab_bot для оплаты подписки ${plan}`,
        Markup.inlineKeyboard([Markup.button.callback('Открыть', `open_pay_${plan}`)]),
      );
    });

    this.bot.action(/^open_pay_(PLUS|PRO)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const plan = ctx.match[1] as 'PLUS' | 'PRO';

      const profile = await this.findOrCreateProfile(ctx.from, undefined, ctx);

      const mainUser = await this.mainUserRepo.findOne({ where: { telegramId: Number(profile.telegramId) } });
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

      const botLink = `https://t.me/test_NLab_bot?start=pay_${plan}`;
      await ctx.editMessageText(
        `Перейдите в @test_NLab_bot для оплаты подписки ${plan}`,
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
      const mainUser = await this.mainUserRepo.findOne({
        where: { telegramId: Number(profile.telegramId) },
      });
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

        const items = await this.orderItemRepo.find({ where: { orderId: order.id } });

        let add = 0;
        let upgrade: 'PLUS' | 'PRO' | null = null;
        let subscription = false;
        for (const item of items) {
          switch (item.promindAction) {
            case 'plus':
              add += 1000;
              upgrade = 'PLUS';
              subscription = true;
              break;
            case 'pro':
              add += 3500;
              upgrade = 'PRO';
              subscription = true;
              break;
            case 'tokens':
              add += 1000;
              break;
            default:
              break;
          }
        }

        if (add === 0) continue;

        const income = await this.incomeRepo.save(
          this.incomeRepo.create({ mainOrderId: order.id, userId: mainUser.id }),
        );

        if (upgrade) {
          profile.tokens.plan = upgrade;
        }

        const now = new Date();
        if (subscription) {
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
