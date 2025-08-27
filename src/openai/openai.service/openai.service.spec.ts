import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenAiService } from './openai.service';
import { SessionService } from '../../session/session.service';

describe('OpenAiService', () => {
  let service: OpenAiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              switch (key) {
                case 'OPENAI_API_KEY_PRO':
                  return 'test-api-key-pro';
                case 'OPENAI_BASE_URL_PRO':
                  return 'https://test.com/v1';
                case 'OPENAI_API_KEY':
                  return 'test-api-key';
                case 'OPENAI_FALLBACK_API_KEY':
                  return 'test-fallback-api-key';
                case 'OPENAI_BASE_URL':
                  return 'https://test.com/v1';
                default:
                  return undefined;
              }
            }),
          },
        },
        {
          provide: SessionService,
          useValue: {
            setSessionId: jest.fn(),
            getSessionId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<OpenAiService>(OpenAiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('normalizeFilename', () => {
    it('should convert uppercase extensions to lowercase', () => {
      const result = (service as any).normalizeFilename('document.DOCX');
      expect(result).toBe('document.docx');
    });

    it('should convert mixed case extensions to lowercase', () => {
      const result = (service as any).normalizeFilename('image.JpG');
      expect(result).toBe('image.jpg');
    });

    it('should not change already lowercase extensions', () => {
      const result = (service as any).normalizeFilename('file.pdf');
      expect(result).toBe('file.pdf');
    });

    it('should handle files without extensions', () => {
      const result = (service as any).normalizeFilename('filename');
      expect(result).toBe('filename');
    });

    it('should handle empty filename', () => {
      const result = (service as any).normalizeFilename('');
      expect(result).toBe('');
    });

    it('should handle null filename', () => {
      const result = (service as any).normalizeFilename(null as any);
      expect(result).toBe(null);
    });

    it('should handle files with multiple dots', () => {
      const result = (service as any).normalizeFilename('my.file.DOCX');
      expect(result).toBe('my.file.docx');
    });
  });
});
