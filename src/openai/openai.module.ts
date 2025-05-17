import { Module } from '@nestjs/common';
import { OpenAiService } from './openai.service/openai.service';

@Module({
  providers: [OpenAiService],
  exports: [OpenAiService], // ← обязательно экспортируем!
})
export class OpenaiModule {}
