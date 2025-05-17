import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VoiceService } from './voice.service/voice.service';

@Module({
  imports: [ConfigModule], // подключаем ConfigModule, если не был подключён
  providers: [VoiceService],
  exports: [VoiceService], // ← обязательно экспортируем!
})
export class VoiceModule {}
