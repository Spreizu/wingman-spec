// @spec billing/add-an-item
package billing

func AddItem(cart *Cart, item Item) error {
	cart.Items = append(cart.Items, item) // @spec billing/add-an-item
	return nil
}

func Total(cart *Cart) float64 {
	// @spec billing/rounding
	s := sum(cart.Items)
	// @spec billing/rounding
	r := round(s)
	// @spec billing/reject-empty

	return r
}
