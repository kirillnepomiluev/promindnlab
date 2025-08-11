import { Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';
import { OpenAiService } from './openai/openai.service/openai.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly openAiService: OpenAiService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('api/status')
  getApiStatus() {
    return this.openAiService.getApiStatus();
  }

  @Post('api/check-main-api')
  async checkMainApi() {
    const isAvailable = await this.openAiService.forceCheckMainApi();
    return {
      success: true,
      isMainApiAvailable: isAvailable,
      message: isAvailable ? 'Основной API доступен' : 'Основной API недоступен, используется fallback'
    };
  }
}
