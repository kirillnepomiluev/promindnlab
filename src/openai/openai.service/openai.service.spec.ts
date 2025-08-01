import { Test, TestingModule } from '@nestjs/testing';
import { OpenAiService } from './openai.service';
import { ConfigService } from '@nestjs/config';
import { SessionService } from '../../session/session.service';

describe('OpenaiService', () => {
  let provider: OpenAiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiService,
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test') } },
        {
          provide: SessionService,
          useValue: {
            getSessionId: jest.fn(),
            setSessionId: jest.fn(),
          },
        },
      ],
    }).compile();

    provider = module.get<OpenAiService>(OpenAiService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
