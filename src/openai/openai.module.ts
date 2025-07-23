import { Module } from '@nestjs/common';
import { OpenAiService } from './openai.service/openai.service';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  providers: [OpenAiService],
  exports: [OpenAiService], // ← обязательно экспортируем!
})
export class OpenaiModule {}
