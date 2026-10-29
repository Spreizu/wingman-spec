package billing

// AddItem adds an item to the cart.
// @spec billing/add-an-item
func AddItem(cart *Cart, item Item) error {
	if item.Qty == 0 {
		// @spec billing/reject-empty
		return ErrEmpty
	}
	cart.Items = append(cart.Items, item)
	return nil
}

// Total is the cart total.
// @spec billing/rounding
func Total(cart *Cart) float64 {
	return round(sum(cart.Items))
}
