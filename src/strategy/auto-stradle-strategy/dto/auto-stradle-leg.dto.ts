import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export class AutoStradleLegDto {
  @IsEnum(['NSE', 'NFO', 'BSE', 'BFO'], {
    message: 'exch must be one of NSE, NFO, BSE, BFO',
  })
  @IsNotEmpty()
  exch: 'NSE' | 'NFO' | 'BSE' | 'BFO'; // MANDATORY

  @IsEnum(['FUTIDX', 'OPTIDX'], {
    message: 'instrument must be one of FUTIDX, OPTIDX',
  })
  @IsNotEmpty()
  instrument: 'FUTIDX' | 'OPTIDX'; // MANDATORY

  @IsEnum(['PE', 'CE'], {
    message: 'optionType must be either PE or CE',
  })
  @IsNotEmpty()
  optionType: 'PE' | 'CE'; // MANDATORY

  @IsString()
  @IsNotEmpty()
  expiry: string; // Format: "17-FEB-2026" - MANDATORY

  @IsEnum(['BUY', 'SELL', 'EXIT'], {
    message: 'side must be one of BUY, SELL, EXIT',
  })
  @IsNotEmpty()
  side: 'BUY' | 'SELL' | 'EXIT'; // MANDATORY
}
