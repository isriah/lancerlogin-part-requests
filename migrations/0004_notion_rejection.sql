-- Why Notion last refused the saved token, and when. Only the code is kept, never anything from Notion's reply. It does not stop
-- requests, so the next call that works can clear it after a brief glitch. It only stops the Admin page reading "Connected".
ALTER TABLE part_requests_notion ADD COLUMN rejection_code TEXT;
ALTER TABLE part_requests_notion ADD COLUMN rejected_ms INTEGER CHECK(rejected_ms IS NULL OR typeof(rejected_ms) = 'integer');
