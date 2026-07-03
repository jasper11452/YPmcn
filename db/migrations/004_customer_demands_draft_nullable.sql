ALTER TABLE customer_demands
    MODIFY COLUMN budget_max_cents BIGINT UNSIGNED NULL,
    MODIFY COLUMN rebate_min_rate DECIMAL(10,6) NULL,
    MODIFY COLUMN quantity_total INT UNSIGNED NULL;
