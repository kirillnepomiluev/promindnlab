import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { OpenAiService } from 'src/openai/openai.service/openai.service';
import { VoiceService } from 'src/voice/voice.service/voice.service';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly openai: OpenAiService,
    private readonly voice: VoiceService,
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

  private registerHandlers() {
    this.bot.on('text', async (ctx) => {
      try {
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
