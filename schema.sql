-- Table to store sellers
CREATE TABLE sellers (
  phone_number TEXT PRIMARY KEY,
  name TEXT,
  last_product_sku TEXT, -- Tracks the last product the seller interacted with
  pending_action TEXT,   -- Tracks the active button (ADD/REMOVE)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table to store products and current stock
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT,
  stock INTEGER DEFAULT 0,
  image_url TEXT, -- Store the WhatsApp Media ID or URL for matching
  seller_phone TEXT REFERENCES sellers(phone_number),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table to log every stock change (history)
CREATE TABLE inventory_logs (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT REFERENCES products(sku),
  change_amount INTEGER,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (optional but recommended for production)
-- ALTER TABLE sellers ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Sample Data (Uncomment to test)
-- INSERT INTO sellers (phone_number, name) VALUES ('867152359972', 'Ahmad');
-- INSERT INTO products (sku, name, stock, seller_phone) VALUES ('SKU001', 'Sample Product', 100, '867152359972');
