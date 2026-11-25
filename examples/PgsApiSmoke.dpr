program PgsApiSmoke;

{$APPTYPE CONSOLE}

uses Windows, SysUtils, Classes, Variants, ComObj, ActiveX;

type
  TPgsReply = record
    OK: Boolean;
    Code, State, RequestId, DocumentId, GuideUrl, ExpiresAt: WideString;
  end;

procedure SkipSpace(const S: WideString; var I: Integer);
begin
  while (I <= Length(S)) and (Ord(S[I]) <= 32) do Inc(I);
end;

procedure Need(const S: WideString; var I: Integer; Ch: WideChar);
begin
  SkipSpace(S,I);
  if (I > Length(S)) or (S[I] <> Ch) then
    raise Exception.Create('Invalid JSON structure');
  Inc(I);
end;

function Quoted(const S: WideString; var I: Integer): WideString;
var Ch: WideChar; N, Code: Integer;
begin
  Result := '';
  Need(S,I,'"');
  while I <= Length(S) do
  begin
    Ch := S[I];
    Inc(I);
    if Ch = '"' then Exit;
    if Ch = '\' then
    begin
      if I > Length(S) then Break;
      Ch := S[I];
      Inc(I);
      case Ch of
        '"','\','/': ;
        'b': Ch := #8;
        'f': Ch := #12;
        'n': Ch := #10;
        'r': Ch := #13;
        't': Ch := #9;
        'u':
          begin
            if I+3 > Length(S) then raise Exception.Create('Invalid JSON escape');
            Val('$'+string(Copy(S,I,4)),N,Code);
            if Code <> 0 then raise Exception.Create('Invalid JSON escape');
            Ch := WideChar(N);
            Inc(I,4);
          end;
      else
        raise Exception.Create('Invalid JSON escape');
      end;
    end
    else if Ord(Ch) < 32 then
      raise Exception.Create('Invalid JSON string');
    Result := Result+Ch;
  end;
  raise Exception.Create('Unterminated JSON string');
end;

function Scalar(const S: WideString; var I: Integer; var IsString: Boolean): WideString;
var Start: Integer;
begin
  SkipSpace(S,I);
  IsString := (I <= Length(S)) and (S[I] = '"');
  if IsString then
  begin
    Result := Quoted(S,I);
    Exit;
  end;
  Start := I;
  while (I <= Length(S)) and (S[I] > ' ') and (S[I] <> ',') and (S[I] <> '}') do Inc(I);
  Result := Copy(S,Start,I-Start);
  if (Result = '') or (Result[1] = '{') or (Result[1] = '[') then
    raise Exception.Create('Expected flat JSON scalar');
end;

function TextOrNull(const Raw: WideString; IsString: Boolean): WideString;
begin
  if IsString then Result := Raw
  else if Raw = 'null' then Result := ''
  else raise Exception.Create('Expected string or null');
end;

function ReadReply(const S: WideString): TPgsReply;
var I: Integer; Name, Raw: WideString; IsString, HasSuccess, HasCode: Boolean;
begin
  Result.OK := False;
  Result.Code := ''; Result.State := ''; Result.RequestId := '';
  Result.DocumentId := ''; Result.GuideUrl := ''; Result.ExpiresAt := '';
  HasSuccess := False;
  HasCode := False;
  I := 1;
  Need(S,I,'{');
  repeat
    Name := Quoted(S,I);
    Need(S,I,':');
    Raw := Scalar(S,I,IsString);
    if Name = 'success' then
    begin
      if IsString or ((Raw <> 'true') and (Raw <> 'false')) then
        raise Exception.Create('Expected JSON Boolean');
      Result.OK := Raw = 'true';
      HasSuccess := True;
    end
    else if Name = 'resultCode' then
    begin
      Result.Code := TextOrNull(Raw,IsString);
      HasCode := Result.Code <> '';
    end
    else if Name = 'status' then Result.State := TextOrNull(Raw,IsString)
    else if Name = 'requestId' then Result.RequestId := TextOrNull(Raw,IsString)
    else if Name = 'documentId' then Result.DocumentId := TextOrNull(Raw,IsString)
    else if Name = 'guideUrl' then Result.GuideUrl := TextOrNull(Raw,IsString)
    else if Name = 'expiresAt' then Result.ExpiresAt := TextOrNull(Raw,IsString);
    SkipSpace(S,I);
    if (I <= Length(S)) and (S[I] = '}') then Break;
    Need(S,I,',');
  until False;
  Need(S,I,'}');
  SkipSpace(S,I);
  if (I <= Length(S)) or not HasSuccess or not HasCode then
    raise Exception.Create('Invalid API response');
end;

function PgsCall(const BaseUrl, Verb, Path, ApiKey, Payload: WideString;
  out HttpStatus: Integer): WideString;
var H: OleVariant;
begin
  H := CreateOleObject('WinHttp.WinHttpRequest.5.1');
  H.SetTimeouts(1500,3000,8000,35000);
  H.Open(Verb,BaseUrl+Path,False);
  H.SetProxy(1);
  H.Option[6] := False; { WinHttpRequestOption_EnableRedirects }
  H.SetRequestHeader('X-API-Key',ApiKey);
  if Verb = 'POST' then
  begin
    H.SetRequestHeader('Content-Type','application/json');
    H.Send(Payload);
  end
  else H.Send(EmptyParam);
  HttpStatus := H.Status;
  Result := H.ResponseText;
end;

function ReadAsciiPayload(const Filename: string): WideString;
var F: TFileStream; Data: AnsiString; I: Integer;
begin
  F := TFileStream.Create(Filename,fmOpenRead or fmShareDenyWrite);
  try
    if (F.Size < 1) or (F.Size > 4096) then raise Exception.Create('Invalid fixture size');
    SetLength(Data,F.Size);
    F.ReadBuffer(Data[1],Length(Data));
    for I := 1 to Length(Data) do
      if Ord(Data[I]) > 127 then raise Exception.Create('Expected ASCII fixture');
    Result := WideString(Data);
  finally F.Free; end;
end;

procedure RequireReady(const R: TPgsReply; HttpStatus: Integer);
begin
  if ((HttpStatus <> 200) and (HttpStatus <> 201)) or not R.OK or
    (R.State <> 'READY') or (R.RequestId = '') or (R.DocumentId = '') or
    (R.GuideUrl = '') or (R.ExpiresAt = '') then
    raise Exception.CreateFmt('Not READY. HTTP %d. Code %s', [HttpStatus,string(R.Code)]);
end;

var
  Key, Base, Answer: WideString;
  Status, ExitStatus: Integer;
  Registered, ByRequest, ByDocument, Retry: TPgsReply;
begin
  ExitStatus := 0;
  CoInitialize(nil);
  try
    try
      if ParamCount <> 1 then raise Exception.Create('Pass the synthetic request JSON file');
      Key := WideString(GetEnvironmentVariable('PGS_INTERNAL_API_KEY'));
      if Key = '' then raise Exception.Create('Set PGS_INTERNAL_API_KEY in this process');
      Base := 'http://127.0.0.1:4206';
      Answer := PgsCall(Base,'GET','/api/v1/internal/health',Key,'',Status);
      ByRequest := ReadReply(Answer);
      if (Status <> 200) or not ByRequest.OK then raise Exception.Create('Health failed');

      Answer := PgsCall(Base,'POST','/api/v1/internal/documents',Key,ReadAsciiPayload(ParamStr(1)),Status);
      Registered := ReadReply(Answer);
      RequireReady(Registered,Status);

      Answer := PgsCall(Base,'GET','/api/v1/internal/requests/'+Registered.RequestId,Key,'',Status);
      ByRequest := ReadReply(Answer);
      RequireReady(ByRequest,Status);

      Answer := PgsCall(Base,'GET','/api/v1/internal/documents/'+Registered.DocumentId,Key,'',Status);
      ByDocument := ReadReply(Answer);
      RequireReady(ByDocument,Status);

      Answer := PgsCall(Base,'POST','/api/v1/internal/documents',Key,ReadAsciiPayload(ParamStr(1)),Status);
      Retry := ReadReply(Answer);
      RequireReady(Retry,Status);
      if (Status <> 200) or (ByRequest.GuideUrl <> Registered.GuideUrl) or
        (ByDocument.GuideUrl <> Registered.GuideUrl) or (Retry.GuideUrl <> Registered.GuideUrl) then
        raise Exception.Create('Link mismatch');
      Writeln('Delphi 7 WinHTTP and JSON: health, registration, both lookups, duplicate retry passed');
    except
      on E: Exception do
      begin
        Writeln(E.ClassName, ': ', E.Message);
        ExitStatus := 1;
      end;
    end;
  finally CoUninitialize; end;
  Halt(ExitStatus);
end.
