import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context, Markup } from 'telegraf';
import * as QRCode from 'qrcode';
import { OpenAiService } from 'src/openai/openai.service/openai.service';
import { VoiceService } from 'src/voice/voice.service/voice.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from 'src/user/entities/user-profile.entity';
import { UserTokens } from 'src/user/entities/user-tokens.entity';
import { MainUser } from 'src/external/entities/main-user.entity';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  // текст приветственного сообщения
  private readonly welcomeMessage =
    'Привет! Я Нейролабик — твой умный и весёлый помощник. Рад знакомству и всегда готов помочь!';
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
    @InjectRepository(MainUser, 'mainDb')
    private readonly mainUserRepo: Repository<MainUser>,
  ) {
    this.registerHandlers();
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

  // Получить ФИО пользователя из основной базы для отображения
  private getFullName(user: MainUser): string {
    const parts = [] as string[];
    if (user.firstName) parts.push(user.firstName);
    if (user.lastName) parts.push(user.lastName);
    return parts.join(' ').trim() || user.username || String(user.telegramId);
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
    }

    if (isNew && ctx) {
      await ctx.reply(this.welcomeMessage);
    }

    return profile;
  }

  /**
   * Проверяет наличие пользователя в БД,
   * создаёт профиль и токены при отсутствии.
   * Также обновляет дату последнего сообщения и списывает один токен.
   * Возвращает профиль или null, если токены закончились.
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

      profile = await this.findOrCreateProfile(
        from,
        mainUser.whoInvitedId ? String(mainUser.whoInvitedId) : undefined,
        ctx,
      );
    } else {
      profile = await this.findOrCreateProfile(from, undefined, ctx);
    }

    if (profile.tokens.tokens <= 0) {
      await ctx.reply('Закончились токены - пополните');
      return null;
    }

    profile.tokens.tokens -= 1;
    await this.tokensRepo.save(profile.tokens);
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
        if (q.startsWith('/') && !q.startsWith('/image')) {
          return next();
        }

        if (q.startsWith('/image')) {
          // Генерация изображения
          // отправляем сообщение-заглушку "РИСУЮ" и потом меняем его на результат
          const placeholder = await ctx.reply('РИСУЮ ...');
          const prompt = q.replace('/image', '').trim();
          const image = await this.openai.generateImage(prompt);
          // удаляем сообщение "РИСУЮ" перед отправкой изображения
          await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение');
          }
        } else {
          // Текстовый чат
          // показываем пользователю, что мы "думаем" над ответом
          const placeholder = await ctx.reply('ДУМАЮ ...');
          const answer = await this.openai.chat(q, ctx.message.from.id);
          if (answer.startsWith('/imagine')) {
            // если ответ подразумевает генерацию изображения,
            // меняем текст заглушки и отправляем изображение
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              placeholder.message_id,
              undefined,
              'РИСУЮ ...',
            );
            const prompt = answer.replace('/imagine', '').trim();
            const image = await this.openai.generateImage(prompt);
            await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
            if (image) {
              await this.sendPhoto(ctx, image);
            } else {
              await ctx.reply('Не удалось сгенерировать изображение');
            }
          } else {
            // подменяем текст заглушки на конечный ответ
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              placeholder.message_id,
              undefined,
              answer,
            );
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
        const tgVoice = ctx.message.voice;
        // показываем процесс распознавания голосового сообщения
        const listenMsg = await ctx.reply('СЛУШАЮ ...');
        const text = await this.voice.voiceToText(tgVoice);
        await ctx.telegram.deleteMessage(ctx.chat.id, listenMsg.message_id);
        if (!text) return;

        const cleaned = text.trim().toLowerCase();
        if (cleaned.startsWith('нарисуй') || cleaned.startsWith('imagine')) {
          // Генерация изображения по голосовому сообщению
          const placeholder = await ctx.reply('РИСУЮ ...');
          const image = await this.openai.generateImage(text);
          await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение по голосовому сообщению');
          }
        } else {
          // Текстовый ответ
          const placeholder = await ctx.reply('ДУМАЮ ...');
          const answer = await this.openai.chat(text, ctx.message.from.id);
          if (answer.startsWith('/imagine')) {
            // Генерация изображения
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              placeholder.message_id,
              undefined,
              'РИСУЮ ...',
            );
            const prompt = answer.replace('/imagine', '').trim();
            const image = await this.openai.generateImage(prompt);
            await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
            if (image) {
              await this.sendPhoto(ctx, image);
            } else {
              await ctx.reply('Не удалось сгенерировать изображение');
            }
          } else {
            // озвучиваем ответ
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              placeholder.message_id,
              undefined,
              'ЗАПИСЫВАЮ ...',
            );
            const ogg = await this.voice.textToSpeech(answer);
            await ctx.telegram.deleteMessage(ctx.chat.id, placeholder.message_id);
            await ctx.replyWithVoice({ source: ogg });
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
        const prompt = ctx.message.text.replace('/img', '').trim();
        const placeholder = await ctx.reply('РИСУЮ ...');
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
      await ctx.reply(this.welcomeMessage);
    });
    // поддерживаем вариант без слеша
    this.bot.hears(/^hello$/i, async (ctx) => {
      await this.findOrCreateProfile(ctx.message.from, undefined, ctx);
      await ctx.reply(this.welcomeMessage);
    });

    // общая функция-обработчик команды /profile и текста "profile"
    const profileHandler = async (ctx: Context) => {
      const profile = await this.findOrCreateProfile(ctx.message.from, undefined, ctx);
      await ctx.reply(
        `Ваш баланс: ${profile.tokens.tokens} токенов`,
        Markup.inlineKeyboard([
          Markup.button.callback('Получить ссылку', 'invite_link'),
        ]),
      );
    };

    // команда для просмотра баланса и получения пригласительной ссылки
    this.bot.command('profile', profileHandler);
    // поддерживаем вариант без слеша
    this.bot.hears(/^profile$/i, profileHandler);

    // обработка перехода по ссылке с кодом
    this.bot.start(async (ctx) => {
      // ctx.startPayload помечен как устаревший,
      // поэтому при необходимости извлекаем код из текста сообщения
      const payload =
        ctx.startPayload ??
        (ctx.message && 'text' in ctx.message
          ? ctx.message.text.replace('/start', '').trim()
          : undefined);
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

    this.bot.catch((err, ctx) => {
      this.logger.error('TG error', err);
      this.logger.debug('Update caused error', JSON.stringify(ctx.update, null, 2));
    });
  }
}
