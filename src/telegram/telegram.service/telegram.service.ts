import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { OpenAiService } from 'src/openai/openai.service/openai.service';
import { VoiceService } from 'src/voice/voice.service/voice.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from 'src/user/entities/user-profile.entity';
import { UserTokens } from 'src/user/entities/user-tokens.entity';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly openai: OpenAiService,
    private readonly voice: VoiceService,
    @InjectRepository(UserProfile)
    private readonly profileRepo: Repository<UserProfile>,
    @InjectRepository(UserTokens)
    private readonly tokensRepo: Repository<UserTokens>,
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

  /**
   * Проверяет наличие пользователя в БД,
   * создаёт профиль и токены при отсутствии.
   * Также обновляет дату последнего сообщения и списывает один токен.
   * Возвращает профиль или null, если токены закончились.
   */
  private async ensureUser(ctx: Context): Promise<UserProfile | null> {
    const from = ctx.message.from;
    let profile = await this.profileRepo.findOne({
      // Сравниваем строковый telegramId
      where: { telegramId: String(from.id) },
      relations: ['tokens'],
    });

    const now = new Date();
    if (!profile) {
      profile = this.profileRepo.create({
        // Сохраняем telegramId как строку
        telegramId: String(from.id),
        firstName: from.first_name,
        username: from.username,
        firstVisitAt: now,
        lastMessageAt: now,
      });
      profile = await this.profileRepo.save(profile);

      let tokens = this.tokensRepo.create({ userId: profile.id });
      tokens = await this.tokensRepo.save(tokens);
      profile.userTokensId = tokens.id;
      await this.profileRepo.save(profile);
      profile.tokens = tokens;
    } else {
      profile.lastMessageAt = now;
      await this.profileRepo.save(profile);
      if (!profile.tokens) {
        profile.tokens = await this.tokensRepo.findOne({
          where: { userId: profile.id },
        });
      }
    }

    if (!profile.tokens) {
      let tokens = this.tokensRepo.create({ userId: profile.id });
      tokens = await this.tokensRepo.save(tokens);
      profile.userTokensId = tokens.id;
      await this.profileRepo.save(profile);
      profile.tokens = tokens;
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
    this.bot.on('text', async (ctx) => {
      try {
        const user = await this.ensureUser(ctx);
        if (!user) return;
        const q = ctx.message.text?.trim();
        if (!q) return;

        if (q.startsWith('/image')) {
          // Генерация изображения
          const prompt = q.replace('/image', '').trim();
          const image = await this.openai.generateImage(prompt);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply('Не удалось сгенерировать изображение');
          }
        } else {
          // Текстовый чат
          const answer = await this.openai.chat(q, ctx.message.from.id);
          if (answer.startsWith('/imagine')) {
            // Генерация изображения
            const prompt = answer.replace('/imagine', '').trim();
            const image = await this.openai.generateImage(prompt);
            if (image) {
              await this.sendPhoto(ctx, image);
            } else {
              await ctx.reply('Не удалось сгенерировать изображение');
            }
          } else {
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
        const tgVoice = ctx.message.voice;
        const text = await this.voice.voiceToText(tgVoice);
        if (!text) return;

        const cleaned = text.trim().toLowerCase();
        if (cleaned.startsWith('нарисуй') || cleaned.startsWith('imagine')) {
          // Генерация изображения по голосовому сообщению
          const image = await this.openai.generateImage(text);
          if (image) {
            await this.sendPhoto(ctx, image);
          } else {
            await ctx.reply(
              'Не удалось сгенерировать изображение по голосовому сообщению',
            );
          }
        } else {
          // Текстовый ответ
          const answer = await this.openai.chat(text, ctx.message.from.id);
          if (answer.startsWith('/imagine')) {
            // Генерация изображения
            const prompt = answer.replace('/imagine', '').trim();
            const image = await this.openai.generateImage(prompt);
            if (image) {
              await this.sendPhoto(ctx, image);
            } else {
              await ctx.reply('Не удалось сгенерировать изображение');
            }
          } else {
            const ogg = await this.voice.textToSpeech(answer);
            await ctx.replyWithVoice({ source: ogg });
          }
        }
      } catch (err) {
        this.logger.error('Ошибка обработки голосового сообщения', err);
        await ctx.reply(
          'Произошла ошибка при обработке вашего голосового сообщения',
        );
      }
    });

    this.bot.command('img', async (ctx) => {
      try {
        const user = await this.ensureUser(ctx);
        if (!user) return;
        const prompt = ctx.message.text.replace('/img', '').trim();
        const image = await this.openai.generateImage(prompt);
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

    this.bot.catch((err, ctx) => {
      this.logger.error('TG error', err);
      this.logger.debug(
        'Update caused error',
        JSON.stringify(ctx.update, null, 2),
      );
    });
  }
}
